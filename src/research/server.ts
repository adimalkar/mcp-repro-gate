import { McpServer } from "@modelcontextprotocol/server";
import * as z from "zod/v4";

import {
  CHARS_PER_TOKEN,
  distillHtml,
  distillPlain,
  selectRelevant,
} from "./distill.js";
import { ResearchError, fetchText, type FetchedPage } from "./fetch.js";

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

export interface ResearchServerOptions {
  /** Fetches one page; tests inject a fixture, the CLI uses fetchText. */
  fetchPage?: (url: string) => Promise<FetchedPage>;
  allowHosts?: readonly string[];
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
        const distilled =
          page.contentType === "text/html" ||
          page.contentType === "application/xhtml+xml"
            ? distillHtml(page.body)
            : distillPlain(page.body);
        const budget = maxTokens * CHARS_PER_TOKEN;
        const header = [
          distilled.title === "" ? undefined : `# ${distilled.title}`,
          `Source: ${page.finalUrl}`,
        ]
          .filter((line) => line !== undefined)
          .join("\n");
        const selected = selectRelevant(
          distilled,
          query,
          Math.max(0, budget - header.length - 2),
        );
        const text = `${header}\n\n${selected.text}`.slice(0, budget);
        const result = {
          url,
          finalUrl: page.finalUrl,
          title: distilled.title,
          estimatedTokens: Math.ceil(text.length / CHARS_PER_TOKEN),
          truncated: selected.truncated,
          text,
        };
        return {
          content: [{ type: "text" as const, text }],
          structuredContent: result,
        };
      } catch (error) {
        const code =
          error instanceof ResearchError ? error.code : "fetch_failed";
        return {
          content: [
            { type: "text" as const, text: JSON.stringify({ error: code }) },
          ],
          isError: true,
        };
      }
    },
  );
  return server;
}
