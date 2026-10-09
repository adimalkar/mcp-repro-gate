import { INVISIBLE_TEXT, cutText } from "./distill.js";
import { ResearchError, fetchText } from "./fetch.js";

export interface SearchResult {
  title: string;
  url: string;
  snippet: string;
}

export type SearchFunction = (
  query: string,
  maxResults: number,
) => Promise<SearchResult[]>;

const JSON_TYPES = new Set(["application/json", "application/search+json"]);
const MAX_SEARCH_BYTES = 1024 * 1024;
const MAX_QUERY_CHARS = 200;
const MAX_EXAMINED_RESULTS = 50;

function clean(value: unknown, length: number): string {
  if (typeof value !== "string") return "";
  return cutText(
    value.replace(INVISIBLE_TEXT, " ").replace(/\s+/gu, " ").trim(),
    length,
  );
}

/**
 * Check an operator's search endpoint template and return its fixed origin.
 * `{query}` may appear only after the authority (in the path, query or
 * fragment), so a query can never choose the host, port or credentials.
 */
export function checkSearchEndpoint(template: string): string {
  const placeholder = template.indexOf("{query}");
  const scheme = template.indexOf("://");
  if (placeholder === -1 || scheme === -1) throw new ResearchError("bad_url");
  const authorityEnd = template.slice(scheme + 3).search(/[/?#]/u);
  if (authorityEnd === -1 || scheme + 3 + authorityEnd > placeholder)
    throw new ResearchError("bad_url");
  // Two different substitutions must name the same plain http(s) origin.
  const origins = ["a", "b.c%2Fd"].map((probe) => {
    let url: URL;
    try {
      url = new URL(template.replaceAll("{query}", probe));
    } catch {
      throw new ResearchError("bad_url");
    }
    if (
      (url.protocol !== "http:" && url.protocol !== "https:") ||
      url.username !== "" ||
      url.password !== ""
    )
      throw new ResearchError("bad_url");
    return url.origin;
  });
  if (origins[0] === undefined || origins[0] !== origins[1])
    throw new ResearchError("bad_url");
  return origins[0];
}

/** A search URL a result may use: http(s) without credentials. */
function usableResultUrl(value: unknown): string | undefined {
  if (typeof value !== "string" || value.length > 2048) return undefined;
  try {
    const url = new URL(value);
    if (
      (url.protocol !== "http:" && url.protocol !== "https:") ||
      url.username !== "" ||
      url.password !== ""
    )
      return undefined;
    return url.toString();
  } catch {
    return undefined;
  }
}

/** Read results from a SearXNG-compatible JSON body. */
export function parseSearchResults(
  body: string,
  maxResults: number,
): SearchResult[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    throw new ResearchError("search_failed");
  }
  const results =
    parsed !== null && typeof parsed === "object" && "results" in parsed
      ? parsed.results
      : undefined;
  if (!Array.isArray(results)) throw new ResearchError("search_failed");
  const seen = new Set<string>();
  const out: SearchResult[] = [];
  // Examine a bounded number of items, whatever the provider sends.
  for (const item of (results as unknown[]).slice(0, MAX_EXAMINED_RESULTS)) {
    if (out.length >= maxResults) break;
    if (item === null || typeof item !== "object") continue;
    const record = item as Record<string, unknown>;
    const url = usableResultUrl(record.url);
    // Fragment variants name the same page.
    const key = url?.replace(/#.*$/su, "");
    if (url === undefined || key === undefined || seen.has(key)) continue;
    seen.add(key);
    out.push({
      title: clean(record.title, 200),
      url,
      snippet: clean(record.content, 300),
    });
  }
  return out;
}

/**
 * Search through the operator's endpoint. No redirect is followed, so a
 * private-endpoint exemption covers that exact origin and nothing else.
 */
export function createEndpointSearch(options: {
  endpoint: string;
  allowPrivateEndpoint?: boolean;
  timeoutMs?: number;
}): SearchFunction {
  const template = options.endpoint;
  const origin = checkSearchEndpoint(template);
  return async (query, maxResults) => {
    const url = template.replaceAll("{query}", encodeURIComponent(query));
    // The exemption and the request stay on the operator's exact origin.
    if (new URL(url).origin !== origin) throw new ResearchError("bad_url");
    let body: string;
    try {
      ({ body } = await fetchText(url, {
        contentTypes: JSON_TYPES,
        accept: "application/json",
        maxRedirects: 0,
        maxBytes: MAX_SEARCH_BYTES,
        ...(options.timeoutMs === undefined
          ? {}
          : { timeoutMs: options.timeoutMs }),
        ...(options.allowPrivateEndpoint === true
          ? { isAllowedAddress: () => true }
          : {}),
      }));
    } catch (error) {
      // Address refusals stay visible; every other failure is one code.
      if (error instanceof ResearchError && error.code === "blocked_address")
        throw error;
      throw new ResearchError("search_failed");
    }
    return parseSearchResults(body, maxResults);
  };
}

/**
 * A search query from an error message: its first meaningful lines without
 * paths, URLs, positions or identifiers, and with best-effort redaction of
 * secrets and addresses. Redaction is pattern-based and cannot be complete:
 * internal host names and unusual secret formats can still remain.
 */
export function errorQuery(error: string): string {
  const lines = error
    .split(/\r?\n/u)
    .map((line) => line.replace(INVISIBLE_TEXT, " ").trim())
    // Stack frames and blank lines carry no searchable message.
    .filter((line) => line.length > 0 && !/^at\s/u.test(line))
    .slice(0, 3);
  const query = lines
    .join(" ")
    // Authorization values, with or without a scheme, keep only the key.
    .replace(
      /(?<![A-Za-z0-9])(authorization)["']?\s*[:=]\s*["']?(?:(?:bearer|basic|digest|token)\s+)?[^\s"',;]+/giu,
      "$1",
    )
    .replace(/\b(bearer|basic)\s+[^\s"',;]{8,}/giu, "$1")
    // Secrets written as KEY=value or "key": "value", including prefixed
    // names such as GITHUB_TOKEN or client_secret, keep the key. Error
    // class names (JsonWebTokenError: ...) are messages, not secrets.
    .replace(
      /(?<![A-Za-z0-9])([\w-]{0,40}?(?:api[-_ ]?key|access[-_ ]?key|secret|token|password|passwd|pwd|session|cookie)[\w-]{0,40})["']?\s*[:=]\s*["']?[^\s"',;]+["']?/giu,
      (whole, key: string) =>
        /(?:error|exception)$/iu.test(key) ? whole : key,
    )
    // "token abc123..." without a separator: only values that look secret,
    // so phrases such as "Unexpected token '<'" stay searchable.
    .replace(
      /\b(api[-_ ]?key|secret|token|password|passwd|session|cookie)\s+(?=\S*\d)(?=\S*[A-Za-z])[^\s"',;]{8,}/giu,
      "$1",
    )
    // JSON Web Tokens and well-known credential prefixes.
    .replace(/\beyJ[\w-]+\.[\w-]+\.[\w-]+/gu, " ")
    .replace(/\b(?:sk|pk|rk)-[\w-]{8,}/gu, " ")
    .replace(/\b(?:gh[pousr]|github_pat|xox[abprs]|glpat)[-_][\w-]{8,}/gu, " ")
    .replace(/\bA(?:KIA|SIA)[0-9A-Z]{12,}/gu, " ")
    .replace(/\b[\w.+-]+@[\w-]+(?:\.[\w-]+)+/gu, " ")
    // Any token with a slash or backslash is a path or URL.
    .replace(/[^\s()"'`]*[/\\][^\s()"'`]*/gu, " ")
    .replace(
      /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/giu,
      " ",
    )
    // IPv4 and IPv6 addresses (with zone), then long opaque strings.
    .replace(/\b(?:\d{1,3}\.){3}\d{1,3}\b/gu, " ")
    // Only whole hex-and-colon tokens with a digit, so code paths such as
    // std::vector or serde::Deserialize are kept.
    .replace(
      /(?<![\w:])(?=[0-9a-f:.]*\d)[0-9a-f]{0,4}(?::[0-9a-f.]{0,4}){2,7}(?:%\S+)?(?![\w:])/giu,
      " ",
    )
    .replace(/\b0x[0-9a-f]+\b/giu, " ")
    .replace(/[A-Za-z0-9+_-]{24,}={0,2}/gu, (token) =>
      /\d/u.test(token) && /[A-Za-z]/u.test(token) ? " " : token,
    )
    .replace(/:\d+(?::\d+)?\b/gu, " ")
    .replace(/\b\d{4,}\b/gu, " ")
    .replace(/\(\s*\)/gu, " ")
    .replace(/\s+/gu, " ")
    .trim();
  return cutText(query, MAX_QUERY_CHARS).trim();
}
