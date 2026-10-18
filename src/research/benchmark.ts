import { Client, InMemoryTransport } from "@modelcontextprotocol/client";

import { CHARS_PER_TOKEN, decodeEntities } from "./distill.js";
import type { FetchedPage } from "./fetch.js";
import { createResearchServer } from "./server.js";

export const RESEARCH_FIXTURE_VERSION = 1;

export interface FixturePage {
  name: string;
  url: string;
  query: string;
  /** A sentence a useful result must keep. */
  answer: string;
  html: string;
}

// A small deterministic generator, so the fixture is identical everywhere.
function random(seed: number): () => number {
  let state = seed;
  return () => {
    // Math.imul keeps the multiply exact in 32 bits.
    state = (Math.imul(state, 1103515245) + 12345) & 0x7fffffff;
    return state / 2147483648;
  };
}

// Filler vocabulary; it avoids every fixture query's distinctive terms.
const WORDS = [
  "the",
  "a",
  "request",
  "response",
  "value",
  "option",
  "returns",
  "buffer",
  "stream",
  "handler",
  "event",
  "callback",
  "promise",
  "string",
  "number",
  "object",
  "array",
  "default",
  "client",
  "server",
  "config",
  "module",
  "import",
  "export",
  "type",
  "error",
  "message",
  "when",
  "with",
  "after",
  "before",
  "each",
  "every",
  "this",
  "that",
  "is",
  "are",
  "can",
  "will",
  "should",
  "may",
  "data",
  "file",
  "path",
  "user",
  "version",
  "release",
  "build",
  "test",
  "run",
  "start",
  "stop",
  "close",
  "open",
  "read",
  "write",
  "output",
  "input",
  "cache",
  "header",
  "token",
  "session",
  "query",
  "result",
  "list",
  "item",
  "field",
  "method",
  "class",
  "function",
  "instance",
  "process",
  "thread",
  "worker",
  "pool",
  "queue",
  "limit",
  "size",
  "length",
  "format",
  "parse",
  "encode",
  "decode",
  "update",
  "change",
  "remove",
  "create",
  "delete",
  "check",
  "valid",
  "state",
  "status",
  "code",
  "line",
  "page",
  "view",
  "layout",
  "style",
  "theme",
  "plugin",
];

function words(next: () => number, count: number): string {
  const out: string[] = [];
  for (let index = 0; index < count; index++)
    out.push(WORDS[Math.floor(next() * WORDS.length)] ?? "the");
  return out.join(" ");
}

function sentence(next: () => number): string {
  const text = words(next, 9 + Math.floor(next() * 10));
  return `${text.charAt(0).toUpperCase()}${text.slice(1)}.`;
}

function paragraph(next: () => number, sentences: number): string {
  return Array.from({ length: sentences }, () => sentence(next)).join(" ");
}

// Utility-class attributes, as many current sites ship them.
const CLASSES = [
  "flex items-center gap-2 px-3 py-1.5 text-sm font-medium text-gray-700 hover:bg-gray-100 rounded-md",
  "block truncate text-slate-600 dark:text-slate-300 hover:text-sky-600 transition-colors duration-150",
  "grid grid-cols-12 gap-x-6 gap-y-4 md:gap-x-8 lg:max-w-7xl mx-auto",
  "inline-flex shrink-0 items-center justify-center rounded-full border border-gray-200 bg-white",
];

function cls(next: () => number): string {
  return CLASSES[Math.floor(next() * CLASSES.length)] ?? "";
}

const ICON =
  '<svg aria-hidden="true" viewBox="0 0 24 24" width="16" height="16"><path fill="currentColor" d="M12 2a10 10 0 1 0 10 10A10 10 0 0 0 12 2zm1 15h-2v-6h2zm0-8h-2V7h2z"/></svg>';

interface Chrome {
  title: string;
  cssRules: number;
  scriptFunctions: number;
  stateItems: number;
  navLinks: number;
  footerLinks: number;
}

function head(next: () => number, chrome: Chrome): string {
  const meta = Array.from(
    { length: 24 },
    (_, index) =>
      `<meta name="m${String(index)}" content="${words(next, 8)}"><link rel="preload" href="/_static/chunk-${String(index)}.js" as="script">`,
  ).join("");
  const css = Array.from(
    { length: chrome.cssRules },
    (_, index) =>
      `.c${String(index)}{display:flex;margin:0 ${String(index % 9)}px;padding:${String(index % 5)}px 8px;color:#3${String(index % 10)}3;font:500 14px/1.4 system-ui}`,
  ).join("");
  const script = Array.from(
    { length: chrome.scriptFunctions },
    (_, index) =>
      `function f${String(index)}(a,b){var c=a&&a.items||[];return c.map(function(d){return d.k${String(index % 7)}+b}).filter(Boolean)}`,
  ).join(";");
  const state = JSON.stringify({
    props: {
      items: Array.from({ length: chrome.stateItems }, (_, index) => ({
        id: index,
        slug: words(next, 3).replaceAll(" ", "-"),
        title: words(next, 6),
        updatedAt: "2026-09-01T00:00:00Z",
      })),
    },
  });
  return `<head><meta charset="utf-8"><title>${chrome.title}</title>${meta}<style>${css}</style><script>${script}</script><script type="application/json" id="__STATE__">${state}</script></head>`;
}

function nav(next: () => number, links: number): string {
  const items = Array.from(
    { length: links },
    () =>
      `<li><a class="${cls(next)}" href="/docs/${words(next, 2).replaceAll(" ", "/")}">${ICON}${words(next, 2 + Math.floor(next() * 3))}</a></li>`,
  ).join("");
  return `<header class="${cls(next)}"><a href="/">${ICON}Home</a><form role="search"><input name="q" placeholder="Search"><button>Search</button></form></header><nav class="${cls(next)}"><ul>${items}</ul></nav>`;
}

function footer(next: () => number, links: number): string {
  const items = Array.from(
    { length: links },
    () => `<a class="${cls(next)}" href="/x">${words(next, 2)}</a>`,
  ).join(" ");
  return `<footer class="${cls(next)}"><div>${items}</div><p>Copyright 2026. ${sentence(next)}</p></footer>`;
}

function page(
  next: () => number,
  chrome: Chrome,
  main: string,
  aside = "",
): string {
  return `<!DOCTYPE html><html lang="en">${head(next, chrome)}<body>${nav(next, chrome.navLinks)}<div class="${cls(next)}"><main class="${cls(next)}">${main}</main>${aside}</div>${footer(next, chrome.footerLinks)}<script src="/_static/app.js"></script></body></html>`;
}

function codeBlock(next: () => number, lines: number): string {
  const body = Array.from(
    { length: lines },
    (_, index) =>
      `const v${String(index)} = ${words(next, 1)}.${words(next, 1)}(${String(index)});`,
  ).join("\n");
  return `<pre><code class="language-js">${body}</code></pre>`;
}

function apiReference(): FixturePage {
  const next = random(1);
  const answer =
    "Set initialDelay in milliseconds to control the delay between the last data packet received and the first keepalive probe.";
  const sections = Array.from({ length: 32 }, (_, index) => {
    if (index === 17)
      return `<section><h3 id="setkeepalive">socket.setKeepAlive([enable][, initialDelay])</h3><p>Enable or disable keep-alive functionality on the socket. ${answer}</p><p>Setting 0 for initialDelay leaves the value unchanged from the default or previous setting.</p><pre><code>socket.setKeepAlive(true, 60000);</code></pre></section>`;
    return `<section><h3>socket.${words(next, 1)}${String(index)}(${words(next, 1)})</h3><p>${paragraph(next, 4)}</p>${codeBlock(next, 4)}<p>${paragraph(next, 2)}</p></section>`;
  }).join("");
  return {
    name: "API reference page",
    url: "https://fixture.example/api/socket",
    query: "socket setKeepAlive initialDelay",
    answer,
    html: page(
      next,
      {
        title: "Socket | netkit API reference",
        cssRules: 900,
        scriptFunctions: 700,
        stateItems: 260,
        navLinks: 180,
        footerLinks: 40,
      },
      `<article><h1>Socket</h1><p>${paragraph(next, 3)}</p>${sections}</article>`,
      `<aside class="${cls(next)}"><h2>On this page</h2>${Array.from({ length: 32 }, () => `<a href="#x">${words(next, 2)}</a>`).join("")}</aside>`,
    ),
  };
}

function qaThread(): FixturePage {
  const next = random(2);
  const answer =
    "The ECONNRESET error appears when the server closes an idle keepAlive socket, so lower the agent keepAlive timeout below the server timeout.";
  const comments = () =>
    `<ul class="comments">${Array.from({ length: 5 }, () => `<li><span>${sentence(next)}</span> <a class="${cls(next)}" href="/u/1">${words(next, 2)}</a> <time>Sep 3, 2026</time></li>`).join("")}</ul>`;
  const vote = () =>
    `<div class="${cls(next)}"><button aria-label="Up vote">${ICON}</button><span>${String(Math.floor(next() * 90))}</span><button aria-label="Down vote">${ICON}</button></div>`;
  const answers = Array.from({ length: 8 }, (_, index) =>
    index === 2
      ? `<div class="answer accepted">${vote()}<div><p>${answer}</p><pre><code>const agent = new Agent({ keepAlive: true, keepAliveTimeout: 4000 });</code></pre><p>${paragraph(next, 2)}</p></div>${comments()}</div>`
      : `<div class="answer">${vote()}<div><p>${paragraph(next, 5)}</p>${index % 2 === 0 ? codeBlock(next, 5) : ""}</div>${comments()}</div>`,
  ).join("");
  const related = (count: number) =>
    Array.from(
      { length: count },
      () =>
        `<li><a class="${cls(next)}" href="/q/1">${words(next, 8)}</a></li>`,
    ).join("");
  return {
    name: "Q&A thread",
    url: "https://fixture.example/questions/1",
    query: "ECONNRESET socket hang up fetch keepAlive",
    answer,
    html: page(
      next,
      {
        title: "fetch fails with ECONNRESET socket hang up - Q&A",
        cssRules: 1100,
        scriptFunctions: 800,
        stateItems: 300,
        navLinks: 60,
        footerLinks: 60,
      },
      `<div class="question">${vote()}<h1>fetch fails with ECONNRESET socket hang up</h1><p>${paragraph(next, 4)}</p>${codeBlock(next, 8)}${comments()}</div><h2>8 Answers</h2>${answers}`,
      `<aside class="${cls(next)}"><h2>Related</h2><ul>${related(30)}</ul><h2>Hot network questions</h2><ul>${related(40)}</ul><iframe src="https://ads.example/slot"></iframe></aside>`,
    ),
  };
}

function tutorialBlog(): FixturePage {
  const next = random(3);
  const answer =
    "Use depends_on with condition service_healthy so the web service starts only after the database healthcheck passes.";
  const sections = Array.from({ length: 12 }, (_, index) =>
    index === 7
      ? `<h2>Waiting for the database</h2><p>${answer}</p><pre><code class="language-yaml">services:\n  web:\n    depends_on:\n      db:\n        condition: service_healthy\n  db:\n    healthcheck:\n      test: ["CMD", "pg_isready"]\n      interval: 5s</code></pre>`
      : `<h2>${words(next, 4)}</h2><p>${paragraph(next, 5)}</p><p>${paragraph(next, 4)}</p>${index % 3 === 0 ? codeBlock(next, 6) : ""}`,
  ).join("");
  const comments = Array.from(
    { length: 20 },
    () =>
      `<div class="comment"><strong>${words(next, 2)}</strong><p>${paragraph(next, 2)}</p><button>Reply</button></div>`,
  ).join("");
  return {
    name: "tutorial blog post",
    url: "https://fixture.example/blog/compose",
    query: "compose healthcheck depends_on service_healthy",
    answer,
    html: page(
      next,
      {
        title: "A practical guide to multi-container apps",
        cssRules: 800,
        scriptFunctions: 600,
        stateItems: 120,
        navLinks: 40,
        footerLinks: 50,
      },
      `<div class="cookie-banner"><p>${paragraph(next, 2)}</p><form><button>Accept all</button><button>Reject</button></form></div><article><h1>A practical guide to multi-container apps</h1><div class="share">${ICON.repeat(6)}</div><p>${paragraph(next, 4)}</p>${sections}</article><form class="newsletter"><input name="email"><button>Subscribe</button></form><section class="comments"><h2>20 comments</h2>${comments}</section>`,
    ),
  };
}

function issueThread(): FixturePage {
  const next = random(4);
  const answer =
    "The TypeError comes from the upgrade leaving items undefined until the first load, so default items to an empty array before calling map.";
  const comments = Array.from({ length: 40 }, (_, index) => {
    const body =
      index === 29
        ? `<p>${answer}</p><pre><code>const { items = [] } = useData();\nreturn items.map(render);</code></pre>`
        : index % 4 === 1
          ? "<p>Same here after upgrading.</p>"
          : `<p>${paragraph(next, 3)}</p>${index % 6 === 0 ? codeBlock(next, 4) : ""}`;
    return `<div class="timeline-item"><div class="${cls(next)}"><a href="/u">${words(next, 1)}${String(index)}</a> commented <time>Sep ${String(1 + (index % 28))}, 2026</time></div><div class="comment-body">${body}</div><div class="reactions">${`<button class="${cls(next)}">${ICON}${String(Math.floor(next() * 9))}</button>`.repeat(3)}</div></div>`;
  }).join("");
  return {
    name: "issue tracker thread",
    url: "https://fixture.example/issues/1",
    query:
      "TypeError Cannot read properties of undefined reading map after upgrade",
    answer,
    html: page(
      next,
      {
        title:
          "TypeError: Cannot read properties of undefined (reading 'map') after upgrade · Issue #1",
        cssRules: 1000,
        scriptFunctions: 900,
        stateItems: 200,
        navLinks: 50,
        footerLinks: 30,
      },
      `<h1>TypeError: Cannot read properties of undefined (reading 'map') after upgrade</h1><div class="labels"><span>bug</span><span>regression</span></div>${comments}`,
      `<aside class="${cls(next)}"><h2>Assignees</h2><p>No one assigned</p><h2>Labels</h2><p>bug regression</p><h2>Participants</h2>${ICON.repeat(12)}</aside>`,
    ),
  };
}

function plainPage(): FixturePage {
  const next = random(5);
  const answer =
    "Set the RETRIES variable to configure how many times a failed request is retried.";
  return {
    name: "small plain page",
    url: "https://fixture.example/readme",
    query: "configure RETRIES retried",
    answer,
    html: `<!DOCTYPE html><html><head><title>fetchkit README</title></head><body><h1>fetchkit</h1><p>${paragraph(next, 3)}</p><h2>Install</h2><pre><code>npm install fetchkit</code></pre><h2>Configure</h2><p>${answer}</p><p>${paragraph(next, 2)}</p></body></html>`,
  };
}

export function fixturePages(): FixturePage[] {
  return [
    apiReference(),
    qaThread(),
    tutorialBlog(),
    issueThread(),
    plainPage(),
  ];
}

// Elements a naive HTML-to-text tool drops; everything else is kept,
// including navigation, footers, forms and comments.
const HIDDEN = new Set(["head", "script", "style", "template"]);

/**
 * Every visible text node, whitespace collapsed: the stricter baseline. A
 * linear pass like the distiller, so fixture size cannot stall it.
 */
export function pageText(html: string): string {
  // ASCII-only lowering keeps every index aligned with the original.
  const lower = html.replace(/[A-Z]+/gu, (run) => run.toLowerCase());
  let out = "";
  let index = 0;
  // The scan only moves forward, so each search below is cached and only
  // repeated once the scan has passed its result; every search starts
  // beyond the last one, which keeps the whole pass linear. -1 means none
  // is left.
  const found = new Map<string, number>();
  const next = (key: string, find: (from: number) => number): number => {
    const cached = found.get(key);
    if (cached !== undefined && (cached === -1 || cached >= index))
      return cached;
    const position = find(Math.max(index, (cached ?? -1) + 1));
    found.set(key, position);
    return position;
  };
  // A real closing tag: "</head" must not match "</header".
  const closing = (name: string) => (from: number) => {
    let end = lower.indexOf(`</${name}`, from);
    while (end !== -1 && /[a-z0-9-]/u.test(lower.charAt(end + 2 + name.length)))
      end = lower.indexOf(`</${name}`, end + 1);
    return end;
  };
  while (index < html.length) {
    const open = html.indexOf("<", index);
    if (open === -1) {
      out += html.slice(index);
      break;
    }
    out += html.slice(index, open);
    if (html.startsWith("<!--", open)) {
      const close = html.indexOf("-->", open + 4);
      index = close === -1 ? html.length : close + 3;
      continue;
    }
    const close = html.indexOf(">", open + 1);
    if (close === -1) break;
    const name = /^<([a-z][a-z0-9]*)/u.exec(lower.slice(open, open + 20))?.[1];
    index = close + 1;
    if (name !== undefined && HIDDEN.has(name)) {
      const end = next(name, closing(name));
      // An omitted </head> ends at <body>, as in a browser.
      const body =
        name === "head"
          ? next("<body", (from) => lower.indexOf("<body", from))
          : -1;
      if (body !== -1 && (end === -1 || body < end)) {
        index = body;
        continue;
      }
      const after = end === -1 ? -1 : html.indexOf(">", end);
      index = after === -1 ? html.length : after + 1;
    } else {
      // Tags separate words, as rendering would.
      out += " ";
    }
  }
  return decodeEntities(out).replace(/\s+/gu, " ").trim();
}

export interface ResearchMeasurement {
  name: string;
  tool: "fetch_distilled" | "resolve_stuck_error";
  query: string;
  rawHtmlBytes: number;
  pageTextBytes: number;
  /** Text content, structuredContent and isError, as a host receives them. */
  measuredBytes: number;
  /** The distilled text alone, sent once in content and once structured. */
  resultTextBytes: number;
  estimatedTokens: number;
  /** Null when the baseline is empty, so no ratio exists. */
  reductionVsHtml: number | null;
  reductionVsText: number | null;
  /** Null when no answer was named, as for a user's own page. */
  answerKept: boolean | null;
  truncated: boolean;
}

export interface ResearchBenchmarkReport {
  fixtureVersion: number;
  rows: ResearchMeasurement[];
  medianReductionVsHtml: number;
  medianReductionVsText: number;
  answersKept: number;
  answersChecked: number;
}

function bytes(text: string): number {
  return Buffer.byteLength(text);
}

// Everything a host receives for one tool call, as in the façade bench.
function visibleBytes(result: unknown): number {
  const { content, structuredContent, isError } = result as {
    content?: unknown;
    structuredContent?: unknown;
    isError?: unknown;
  };
  return bytes(JSON.stringify({ content, structuredContent, isError }));
}

// A failed call would look like a large saving; refuse to measure it.
export function succeededResult(
  name: string,
  result: unknown,
): { text: string; truncated: boolean } {
  const { isError, structuredContent } = result as {
    isError?: unknown;
    structuredContent?: unknown;
  };
  if (
    isError === true ||
    structuredContent === null ||
    typeof structuredContent !== "object" ||
    !("text" in structuredContent) ||
    typeof structuredContent.text !== "string"
  )
    throw new Error(`Benchmark call ${name} did not succeed`);
  const truncated =
    "truncated" in structuredContent && structuredContent.truncated === true;
  return { text: structuredContent.text, truncated };
}

function round(value: number): number {
  return Math.round(value * 10_000) / 10_000;
}

function median(values: readonly number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1
    ? (sorted[middle] ?? 0)
    : ((sorted[middle - 1] ?? 0) + (sorted[middle] ?? 0)) / 2;
}

interface ServedPage {
  url: string;
  html: string;
  name?: string;
}

async function connect(pages: readonly ServedPage[], search?: string[]) {
  const byUrl = new Map(pages.map((item) => [item.url, item]));
  const server = createResearchServer({
    fetchPage: (url) => {
      const found = byUrl.get(url);
      if (found === undefined) throw new Error(`No fixture page for ${url}`);
      const fetched: FetchedPage = {
        url,
        finalUrl: url,
        contentType: "text/html",
        body: found.html,
      };
      return Promise.resolve(fetched);
    },
    ...(search === undefined
      ? {}
      : {
          search: () =>
            Promise.resolve(
              search.map((url) => ({
                title: byUrl.get(url)?.name ?? url,
                url,
                snippet: "",
              })),
            ),
        }),
  });
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "research-bench", version: "1.0.0" });
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  return {
    call: (name: string, args: Record<string, unknown>) =>
      client.callTool({ name, arguments: args }),
    close: async () => {
      await client.close();
      await server.close();
    },
  };
}

function reduction(measured: number, baseline: number): number | null {
  return baseline === 0 ? null : round(1 - measured / baseline);
}

function measurement(
  name: string,
  tool: ResearchMeasurement["tool"],
  query: string,
  sources: readonly { html: string }[],
  answer: string | undefined,
  result: unknown,
): ResearchMeasurement {
  const { text, truncated } = succeededResult(name, result);
  const rawHtmlBytes = sources.reduce((sum, item) => sum + bytes(item.html), 0);
  const pageTextBytes = sources.reduce(
    (sum, item) => sum + bytes(pageText(item.html)),
    0,
  );
  const measuredBytes = visibleBytes(result);
  return {
    name,
    tool,
    query,
    rawHtmlBytes,
    pageTextBytes,
    measuredBytes,
    resultTextBytes: bytes(text),
    estimatedTokens: Math.ceil(measuredBytes / CHARS_PER_TOKEN),
    reductionVsHtml: reduction(measuredBytes, rawHtmlBytes),
    reductionVsText: reduction(measuredBytes, pageTextBytes),
    answerKept: answer === undefined ? null : text.includes(answer),
    truncated,
  };
}

/** Measure one locally saved page; nothing is fetched. */
export async function measurePage(
  html: string,
  query: string,
  name = "local page",
): Promise<ResearchMeasurement> {
  const local: ServedPage = { name, url: "https://local.invalid/page", html };
  const session = await connect([local]);
  try {
    const result = await session.call("fetch_distilled", {
      url: local.url,
      query,
    });
    return measurement(
      name,
      "fetch_distilled",
      query,
      [local],
      undefined,
      result,
    );
  } finally {
    await session.close();
  }
}

export const RESOLVER_ERROR =
  "TypeError: Cannot read properties of undefined (reading 'map')\n    at render (/app/src/list.tsx:12:20)";

/**
 * Measure the fixture through a real MCP client against the research
 * server, with default budgets. Pages are injected, so nothing is fetched.
 */
export async function runResearchBenchmark(): Promise<ResearchBenchmarkReport> {
  const pages = fixturePages();
  const rows: ResearchMeasurement[] = [];
  const fetchSession = await connect(pages);
  try {
    for (const item of pages)
      rows.push(
        measurement(
          item.name,
          "fetch_distilled",
          item.query,
          [item],
          item.answer,
          await fetchSession.call("fetch_distilled", {
            url: item.url,
            query: item.query,
          }),
        ),
      );
  } finally {
    await fetchSession.close();
  }
  // The resolver reads the issue, the Q&A thread and the tutorial.
  const sources = [pages[3], pages[1], pages[2]].filter(
    (item): item is FixturePage => item !== undefined,
  );
  const resolverSession = await connect(
    pages,
    sources.map((item) => item.url),
  );
  try {
    const result = await resolverSession.call("resolve_stuck_error", {
      error: RESOLVER_ERROR,
    });
    // The baseline counts every source, so every source must have been read.
    const read = result.structuredContent as
      { sources?: unknown[]; skipped?: unknown } | undefined;
    if (read?.skipped !== 0 || read.sources?.length !== sources.length)
      throw new Error("Benchmark resolver did not read every source");
    rows.push(
      measurement(
        "error resolver, 3 pages",
        "resolve_stuck_error",
        "(derived from the error)",
        sources,
        sources[0]?.answer,
        result,
      ),
    );
  } finally {
    await resolverSession.close();
  }
  const checked = rows.filter((row) => row.answerKept !== null);
  return {
    fixtureVersion: RESEARCH_FIXTURE_VERSION,
    rows,
    medianReductionVsHtml: round(median(ratios(rows, "reductionVsHtml"))),
    medianReductionVsText: round(median(ratios(rows, "reductionVsText"))),
    answersKept: checked.filter((row) => row.answerKept === true).length,
    answersChecked: checked.length,
  };
}

function ratios(
  rows: readonly ResearchMeasurement[],
  key: "reductionVsHtml" | "reductionVsText",
): number[] {
  return rows.flatMap((row) => (row[key] === null ? [] : [row[key]]));
}

function percent(value: number | null): string {
  return value === null ? "n/a" : `${(value * 100).toFixed(1)}%`;
}

/** A fixed-width text table for terminals. */
export function formatResearchReport(
  report: Pick<ResearchBenchmarkReport, "rows"> &
    Partial<ResearchBenchmarkReport>,
): string {
  const header = [
    "page",
    "raw HTML B",
    "page text B",
    "measured B",
    "text B",
    "vs HTML",
    "vs text",
    "answer",
    "truncated",
  ];
  const rows = report.rows.map((row) => [
    row.name,
    String(row.rawHtmlBytes),
    String(row.pageTextBytes),
    String(row.measuredBytes),
    String(row.resultTextBytes),
    percent(row.reductionVsHtml),
    percent(row.reductionVsText),
    row.answerKept === null ? "-" : row.answerKept ? "kept" : "lost",
    row.truncated ? "yes" : "no",
  ]);
  const widths = header.map((title, column) =>
    Math.max(title.length, ...rows.map((row) => (row[column] ?? "").length)),
  );
  const line = (cells: string[]) =>
    cells.map((cell, column) => cell.padEnd(widths[column] ?? 0)).join("  ");
  const summary =
    report.medianReductionVsHtml === undefined ||
    report.medianReductionVsText === undefined
      ? []
      : [
          `median reduction ${percent(report.medianReductionVsHtml)} vs raw HTML, ${percent(report.medianReductionVsText)} vs page text; answers kept ${String(report.answersKept)}/${String(report.answersChecked)}`,
        ];
  return [
    report.fixtureVersion === undefined
      ? "Research measurement, local page, UTF-8 bytes"
      : `Research measurement, fixture v${String(report.fixtureVersion)} (synthetic pages), UTF-8 bytes`,
    line(header),
    ...rows.map(line),
    ...summary,
    "Bytes, not host tokens. Measured counts text content and structuredContent, which both carry the text (text B). See docs/RESEARCH.md.",
    "",
  ].join("\n");
}
