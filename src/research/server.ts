import { McpServer } from "@modelcontextprotocol/server";
import * as z from "zod/v4";

import {
  CHARS_PER_TOKEN,
  cutText,
  distillHtml,
  distillPlain,
  selectRelevant,
} from "./distill.js";
import {
  ResearchError,
  fetchText,
  type FetchedPage,
  type ResearchErrorCode,
} from "./fetch.js";
import { errorQuery, type SearchFunction } from "./search.js";

export const DEFAULT_MAX_TOKENS = 900;
export const MAX_TOKENS = 1000;

export const fetchDistilledOutputSchema = z.object({
  url: z.string(),
  finalUrl: z.string(),
  title: z.string(),
  estimatedTokens: z.number().int().min(0),
  truncated: z.boolean(),
  text: z.string(),
});

export const webSearchOutputSchema = z.object({
  results: z.array(
    z.object({ title: z.string(), url: z.string(), snippet: z.string() }),
  ),
});

export const resolveStuckErrorOutputSchema = z.object({
  query: z.string(),
  sources: z.array(z.object({ url: z.string(), title: z.string() })),
  skipped: z.number().int().min(0),
  estimatedTokens: z.number().int().min(0),
  truncated: z.boolean(),
  text: z.string(),
});

export interface ResearchServerOptions {
  /** Fetches one page; tests inject a fixture, the CLI uses fetchText. */
  fetchPage?: (url: string) => Promise<FetchedPage>;
  allowHosts?: readonly string[];
  /** The operator's search provider; without it no search tools exist. */
  search?: SearchFunction;
}

const RESOLVER_SOURCES = 3;

function distillPage(page: FetchedPage) {
  return page.contentType === "text/html" ||
    page.contentType === "application/xhtml+xml"
    ? distillHtml(page.body)
    : distillPlain(page.body);
}

function shownUrl(url: string): string {
  // Capped so a long URL cannot crowd out content.
  return url.length > 300 ? `${cutText(url, 299)}…` : url;
}

function refusal(error: unknown, fallback: ResearchErrorCode) {
  const code = error instanceof ResearchError ? error.code : fallback;
  return {
    content: [{ type: "text" as const, text: JSON.stringify({ error: code }) }],
    isError: true,
  };
}

/**
 * A stdio research backend. ReproGate catalogs it like any other backend
 * (network_read), so every fetch is planned, approved or mediated, and
 * receipted; the gateway itself makes no network requests.
 */
export function createResearchServer(
  options: ResearchServerOptions = {},
): McpServer {
  const fetchPage =
    options.fetchPage ??
    ((url: string) =>
      fetchText(url, {
        ...(options.allowHosts === undefined
          ? {}
          : { allowHosts: options.allowHosts }),
      }));
  const server = new McpServer({
    name: "reprogate-research",
    version: "0.0.0",
  });
  server.registerTool(
    "fetch_distilled",
    {
      description:
        "Fetch one public web page and return its title plus the passages most relevant to the query, with code blocks kept, within an estimated token budget",
      inputSchema: z.object({
        url: z.string().min(1).max(2048),
        query: z.string().min(1).max(512),
        maxTokens: z
          .number()
          .int()
          .min(100)
          .max(MAX_TOKENS)
          .default(DEFAULT_MAX_TOKENS),
      }),
      outputSchema: fetchDistilledOutputSchema,
      annotations: {
        readOnlyHint: true,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async ({ url, query, maxTokens }) => {
      try {
        const page = await fetchPage(url);
        const distilled = distillPage(page);
        const budget = maxTokens * CHARS_PER_TOKEN;
        // structuredContent.finalUrl keeps the URL whole.
        const header = [
          distilled.title === "" ? undefined : `# ${distilled.title}`,
          `Source: ${shownUrl(page.finalUrl)}`,
        ]
          .filter((line) => line !== undefined)
          .join("\n");
        const selected = selectRelevant(
          distilled,
          query,
          Math.max(0, budget - header.length - 2),
        );
        const full = `${header}\n\n${selected.text}`;
        const text = cutText(full, budget);
        const result = {
          url,
          finalUrl: page.finalUrl,
          title: distilled.title,
          estimatedTokens: Math.ceil(text.length / CHARS_PER_TOKEN),
          truncated: selected.truncated || text.length < full.length,
          text,
        };
        return {
          content: [{ type: "text" as const, text }],
          structuredContent: result,
        };
      } catch (error) {
        return refusal(error, "fetch_failed");
      }
    },
  );

  const search = options.search;
  if (search === undefined) return server;

  server.registerTool(
    "web_search",
    {
      description:
        "Search the web through the operator's configured search provider and return titles, URLs and short snippets",
      inputSchema: z.object({
        query: z.string().min(1).max(512),
        maxResults: z.number().int().min(1).max(10).default(5),
      }),
      outputSchema: webSearchOutputSchema,
      annotations: {
        readOnlyHint: true,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async ({ query, maxResults }) => {
      try {
        const results = await search(query, maxResults);
        const text = results
          .map(
            (item) => `${item.title} — ${shownUrl(item.url)}\n${item.snippet}`,
          )
          .join("\n\n");
        return {
          content: [{ type: "text" as const, text }],
          structuredContent: { results },
        };
      } catch (error) {
        return refusal(error, "search_failed");
      }
    },
  );

  server.registerTool(
    "resolve_stuck_error",
    {
      description:
        "Search for an error message, read the top results and return the passages and code most relevant to fixing it, with sources, within an estimated token budget",
      inputSchema: z.object({
        error: z.string().min(1).max(4096),
        context: z.string().max(1024).optional(),
        maxTokens: z
          .number()
          .int()
          .min(100)
          .max(MAX_TOKENS)
          .default(DEFAULT_MAX_TOKENS),
      }),
      outputSchema: resolveStuckErrorOutputSchema,
      annotations: {
        readOnlyHint: true,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async ({ error, context, maxTokens }) => {
      try {
        const query = errorQuery(error);
        if (query === "") throw new ResearchError("no_results");
        const results = await search(query, RESOLVER_SOURCES);
        if (results.length === 0) throw new ResearchError("no_results");
        // Each result URL goes through the full fetch policy.
        const settled = await Promise.allSettled(
          results.map((item) => fetchPage(item.url)),
        );
        const pages = settled.flatMap((outcome, index) =>
          outcome.status === "fulfilled"
            ? [{ page: outcome.value, result: results[index] }]
            : [],
        );
        if (pages.length === 0) throw new ResearchError("no_results");
        const budget = maxTokens * CHARS_PER_TOKEN;
        const header = `Query: ${query}`;
        const relevance = `${query} ${context ?? ""}`;
        const sections = pages.map(({ page, result }) => {
          const distilled = distillPage(page);
          const title =
            distilled.title !== ""
              ? distilled.title
              : result !== undefined && result.title !== ""
                ? result.title
                : page.finalUrl;
          const sectionHeader = `## ${cutText(title, 200)}\nSource: ${shownUrl(page.finalUrl)}`;
          // Share the budget evenly between the pages that could be read.
          const share =
            Math.floor((budget - header.length - 2) / pages.length) -
            sectionHeader.length -
            4;
          // An error term is common on a page about that error, so rarity
          // would rank comments with incidental hits above a fix that only
          // names the error; every term counts the same here.
          const selected = selectRelevant(
            distilled,
            relevance,
            Math.max(0, share),
            { rarity: false },
          );
          return {
            section: `${sectionHeader}\n\n${selected.text}`,
            source: { url: page.finalUrl, title: cutText(title, 200) },
            truncated: selected.truncated,
          };
        });
        const full = [header, ...sections.map((item) => item.section)].join(
          "\n\n",
        );
        const text = cutText(full, budget);
        const structured = {
          query,
          sources: sections.map((item) => item.source),
          skipped: results.length - pages.length,
          estimatedTokens: Math.ceil(text.length / CHARS_PER_TOKEN),
          truncated:
            sections.some((item) => item.truncated) ||
            text.length < full.length,
          text,
        };
        return {
          content: [{ type: "text" as const, text }],
          structuredContent: structured,
        };
      } catch (caught) {
        return refusal(caught, "search_failed");
      }
    },
  );
  return server;
}
