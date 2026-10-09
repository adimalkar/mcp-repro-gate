import { lookup as dnsLookup } from "node:dns";
import { request as httpRequest, type IncomingMessage } from "node:http";
import { request as httpsRequest } from "node:https";
import { isIP, type LookupFunction } from "node:net";

import { isBlockedAddress } from "./address-policy.js";

export type ResearchErrorCode =
  | "bad_url"
  | "blocked_host"
  | "blocked_address"
  | "too_large"
  | "unsupported_type"
  | "timeout"
  | "http_status"
  | "fetch_failed"
  | "search_failed"
  | "no_results";

/** A refusal with a stable code; it never carries response content. */
export class ResearchError extends Error {
  constructor(readonly code: ResearchErrorCode) {
    super(`Research fetch refused: ${code}`);
    this.name = "ResearchError";
  }
}

export interface FetchOptions {
  /** Hosts allowed to be fetched; ".example.com" also matches subdomains. */
  allowHosts?: readonly string[];
  timeoutMs?: number;
  maxBytes?: number;
  maxRedirects?: number;
  /** Accepted content types; defaults to the readable text types. */
  contentTypes?: ReadonlySet<string>;
  /**
   * Decides which resolved addresses may be connected to. Production sets
   * it only for the operator's --search-endpoint-private exemption, where no
   * redirect is followed; tests use it to reach a local server.
   */
  isAllowedAddress?: (address: string) => boolean;
}

export interface FetchedPage {
  url: string;
  finalUrl: string;
  contentType: string;
  body: string;
}

const TEXT_TYPES = new Set([
  "text/html",
  "application/xhtml+xml",
  "text/plain",
  "text/markdown",
]);
const REDIRECTS = new Set([301, 302, 303, 307, 308]);

/** Parse and check a URL before any network activity. */
export function checkUrl(value: string, allowHosts?: readonly string[]): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new ResearchError("bad_url");
  }
  if (
    (url.protocol !== "http:" && url.protocol !== "https:") ||
    url.username !== "" ||
    url.password !== "" ||
    url.hostname === ""
  )
    throw new ResearchError("bad_url");
  if (allowHosts !== undefined && allowHosts.length > 0) {
    // "example.com." names the same host as "example.com".
    const host = url.hostname.toLowerCase().replace(/\.$/u, "");
    const allowed = allowHosts.some((entry) => {
      const rule = entry.toLowerCase();
      return rule.startsWith(".")
        ? host.endsWith(rule) || host === rule.slice(1)
        : host === rule;
    });
    if (!allowed) throw new ResearchError("blocked_host");
  }
  return url;
}

// Resolve every address and refuse the connection if any is blocked, so a
// name cannot mix a public and a private answer. Node connects only to the
// addresses returned here, which closes DNS-rebinding gaps. With automatic
// family selection (the Node 20+ default) Node asks for every address.
function guardedLookup(allowed: (address: string) => boolean): LookupFunction {
  return (hostname, options, callback) => {
    dnsLookup(hostname, { all: true, verbatim: true }, (error, addresses) => {
      if (error !== null) {
        callback(error, "", 4);
        return;
      }
      const first = addresses[0];
      if (
        first === undefined ||
        addresses.some(({ address }) => !allowed(address))
      ) {
        callback(new ResearchError("blocked_address"), "", 4);
        return;
      }
      if (options.all === true) {
        callback(null, addresses);
        return;
      }
      callback(null, first.address, first.family);
    });
  };
}

/** A redirect may not downgrade from https to plain http. */
export function redirectAllowed(from: URL, to: URL): boolean {
  return !(from.protocol === "https:" && to.protocol !== "https:");
}

function bareHost(url: URL): string {
  return url.hostname.startsWith("[")
    ? url.hostname.slice(1, -1)
    : url.hostname;
}

/** Fetch one text page with address, redirect, size, type and time limits. */
export async function fetchText(
  value: string,
  options: FetchOptions = {},
): Promise<FetchedPage> {
  const allowed =
    options.isAllowedAddress ??
    ((address: string) => !isBlockedAddress(address));
  const timeoutMs = options.timeoutMs ?? 10_000;
  const maxBytes = options.maxBytes ?? 2 * 1024 * 1024;
  const maxRedirects = options.maxRedirects ?? 3;
  const deadline = Date.now() + timeoutMs;
  let url = checkUrl(value, options.allowHosts);
  for (let hop = 0; ; hop++) {
    // IP literals skip DNS, so check them directly.
    const host = bareHost(url);
    if (isIP(host) !== 0 && !allowed(host))
      throw new ResearchError("blocked_address");
    const response = await open(url, allowed, deadline);
    const status = response.statusCode ?? 0;
    if (REDIRECTS.has(status)) {
      response.destroy();
      const location = response.headers.location;
      if (location === undefined || hop >= maxRedirects)
        throw new ResearchError("http_status");
      let next: string;
      try {
        next = new URL(location, url).toString();
      } catch {
        throw new ResearchError("bad_url");
      }
      const following = checkUrl(next, options.allowHosts);
      if (!redirectAllowed(url, following))
        throw new ResearchError("http_status");
      url = following;
      continue;
    }
    if (status < 200 || status >= 300) {
      response.destroy();
      throw new ResearchError("http_status");
    }
    const contentType = (response.headers["content-type"] ?? "")
      .split(";")[0]
      ?.trim()
      .toLowerCase();
    if (
      contentType === undefined ||
      !(options.contentTypes ?? TEXT_TYPES).has(contentType)
    ) {
      response.destroy();
      throw new ResearchError("unsupported_type");
    }
    const declared = Number(response.headers["content-length"]);
    if (Number.isFinite(declared) && declared > maxBytes) {
      response.destroy();
      throw new ResearchError("too_large");
    }
    const body = await readBody(response, maxBytes, deadline);
    return { url: value, finalUrl: url.toString(), contentType, body };
  }
}

function open(
  url: URL,
  allowed: (address: string) => boolean,
  deadline: number,
): Promise<IncomingMessage> {
  return new Promise((resolve, reject) => {
    const remaining = deadline - Date.now();
    if (remaining <= 0) {
      reject(new ResearchError("timeout"));
      return;
    }
    const request = (url.protocol === "https:" ? httpsRequest : httpRequest)(
      url,
      {
        method: "GET",
        agent: false,
        lookup: guardedLookup(allowed),
        headers: {
          accept: "text/html, text/plain;q=0.9, text/markdown;q=0.9",
          "user-agent": "reprogate-research/1",
        },
        timeout: remaining,
      },
      resolve,
    );
    const timer = setTimeout(() => {
      request.destroy(new ResearchError("timeout"));
    }, remaining);
    request.once("response", () => {
      clearTimeout(timer);
    });
    request.once("timeout", () => {
      request.destroy(new ResearchError("timeout"));
    });
    request.once("error", (error) => {
      clearTimeout(timer);
      reject(
        error instanceof ResearchError
          ? error
          : new ResearchError("fetch_failed"),
      );
    });
    request.end();
  });
}

function readBody(
  response: IncomingMessage,
  maxBytes: number,
  deadline: number,
): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    const timer = setTimeout(
      () => {
        response.destroy(new ResearchError("timeout"));
      },
      Math.max(0, deadline - Date.now()),
    );
    response.on("data", (chunk: Buffer) => {
      total += chunk.length;
      if (total > maxBytes) {
        response.destroy(new ResearchError("too_large"));
        return;
      }
      chunks.push(chunk);
    });
    response.once("error", (error) => {
      clearTimeout(timer);
      reject(
        error instanceof ResearchError
          ? error
          : new ResearchError("fetch_failed"),
      );
    });
    response.once("end", () => {
      clearTimeout(timer);
      resolve(Buffer.concat(chunks).toString("utf8"));
    });
  });
}
