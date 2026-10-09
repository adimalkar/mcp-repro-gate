import { cutText } from "./distill.js";
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

// Control and bidirectional-formatting characters, removed from provider
// text before it reaches a model or a terminal.
const UNSAFE_TEXT = new RegExp(
  // eslint-disable-next-line no-control-regex -- Matching control characters is the purpose.
  "[\\u0000-\\u001f\\u007f-\\u009f\\u061c\\u200e\\u200f\\u202a-\\u202e\\u2066-\\u2069]",
  "gu",
);

function clean(value: unknown, length: number): string {
  if (typeof value !== "string") return "";
  return cutText(
    value.replace(UNSAFE_TEXT, " ").replace(/\s+/gu, " ").trim(),
    length,
  );
}

/**
 * Check an operator's search endpoint template: an http(s) URL without
 * credentials whose `{query}` placeholder takes the encoded query.
 */
export function checkSearchEndpoint(template: string): string {
  if (!template.includes("{query}")) throw new ResearchError("bad_url");
  let url: URL;
  try {
    url = new URL(template.replaceAll("{query}", "q"));
  } catch {
    throw new ResearchError("bad_url");
  }
  if (
    (url.protocol !== "http:" && url.protocol !== "https:") ||
    url.username !== "" ||
    url.password !== ""
  )
    throw new ResearchError("bad_url");
  return template;
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
  for (const item of results as unknown[]) {
    if (out.length >= maxResults) break;
    if (item === null || typeof item !== "object") continue;
    const record = item as Record<string, unknown>;
    const url = usableResultUrl(record.url);
    if (url === undefined || seen.has(url)) continue;
    seen.add(url);
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
  const template = checkSearchEndpoint(options.endpoint);
  return async (query, maxResults) => {
    const url = template.replaceAll("{query}", encodeURIComponent(query));
    let body: string;
    try {
      ({ body } = await fetchText(url, {
        contentTypes: JSON_TYPES,
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
 * paths, URLs, addresses, positions, identifiers or long numbers.
 */
export function errorQuery(error: string): string {
  const lines = error
    .split(/\r?\n/u)
    .map((line) => line.replace(UNSAFE_TEXT, " ").trim())
    // Stack frames and blank lines carry no searchable message.
    .filter((line) => line.length > 0 && !/^at\s/u.test(line))
    .slice(0, 3);
  const query = lines
    .join(" ")
    // Any token with a slash or backslash is a path or URL.
    .replace(/[^\s()"'`]*[/\\][^\s()"'`]*/gu, " ")
    .replace(
      /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/giu,
      " ",
    )
    .replace(/\b0x[0-9a-f]+\b/giu, " ")
    .replace(/:\d+(?::\d+)?\b/gu, " ")
    .replace(/\b\d{4,}\b/gu, " ")
    .replace(/\(\s*\)/gu, " ")
    .replace(/\s+/gu, " ")
    .trim();
  return cutText(query, MAX_QUERY_CHARS).trim();
}
