import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import test, { type TestContext } from "node:test";
import { fileURLToPath } from "node:url";

import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";

import { CHARS_PER_TOKEN } from "../src/research/distill.js";
import { ResearchError, type FetchedPage } from "../src/research/fetch.js";
import {
  checkSearchEndpoint,
  createEndpointSearch,
  errorQuery,
  parseSearchResults,
  type SearchFunction,
} from "../src/research/search.js";
import {
  createResearchServer,
  resolveStuckErrorOutputSchema,
  webSearchOutputSchema,
} from "../src/research/server.js";

const refused = (code: string) => (error: unknown) =>
  error instanceof ResearchError && error.code === code;

test("error queries keep the message and drop paths, addresses and positions", () => {
  assert.equal(
    errorQuery(
      'TypeError: Cannot read properties of undefined (reading "map")\n    at render (/home/u/app/src/view.ts:42:13)\n    at main (/home/u/app/src/index.ts:7:1)',
    ),
    'TypeError: Cannot read properties of undefined (reading "map")',
  );
  assert.equal(
    errorQuery(
      "Error: ENOENT: no such file or directory, open C:\\Users\\a\\proj\\config.json",
    ),
    "Error: ENOENT: no such file or directory, open",
  );
  const npm = errorQuery(
    "npm ERR! code ERESOLVE\nnpm ERR! unable to resolve tree https://registry.npmjs.org/x 0x7ffde12 3f2a9b1c-1111-4abc-8def-123456789012 build 123456",
  );
  for (const gone of ["https", "0x7ffde12", "3f2a9b1c", "123456"])
    assert.equal(npm.includes(gone), false, gone);
  assert.match(npm, /ERESOLVE/u);
  assert.equal(errorQuery("/a/b C:\\d\n   at x (y)"), "");
  assert.ok(errorQuery("word ".repeat(200)).length <= 200);

  // Secrets and addresses are redacted on a best-effort basis.
  for (const [error, expected] of [
    [
      "Error: connect ECONNREFUSED 10.0.0.5:5432",
      "Error: connect ECONNREFUSED",
    ],
    ["ENOTFOUND fe80::1%eth0 and 2001:db8::1", "ENOTFOUND and"],
    ["Invalid API key: sk-abcdefghijklmnop1234", "Invalid API key"],
    [
      "Error: jwt expired eyJhbGciOi.eyJzdWIiOi.c2lnbmF0dXJl",
      "Error: jwt expired",
    ],
    ["Unauthorized token=ghp_abcdefghijklmnop for", "Unauthorized token for"],
    ["AWS AKIAABCDEFGHIJKLMNOP denied", "AWS denied"],
    ["mail admin@corp.internal now", "mail now"],
    ["password: hunter2 rejected", "password rejected"],
    ["opaque Zm9vYmFyYmF6cXV4MTIzNDU2Nzg5MA== trailing", "opaque trailing"],
  ] as const)
    assert.equal(errorQuery(error), expected, error);
  // Prefixed names, JSON keys and authorization schemes.
  for (const [error, expected] of [
    [
      "GITHUB_TOKEN=ghx_short1 DB_PASSWORD=hunter2 client_secret=abc123 access_token=zzz9",
      "GITHUB_TOKEN DB_PASSWORD client_secret access_token",
    ],
    ['{"password":"hunter2","apiKey":"k1"}', '{"password,"apiKey}'],
    ["Authorization: Bearer abc123def", "Authorization"],
    ["Bearer abc123def456 rejected", "Bearer rejected"],
    ["token abc123def456 expired", "token expired"],
  ] as const)
    assert.equal(errorQuery(error), expected, error);
  // Ordinary words after a key name stay searchable.
  for (const error of [
    `SyntaxError: Unexpected token '<', "<!DOCTYPE "... is not valid JSON`,
    'password authentication failed for user "postgres"',
  ])
    assert.equal(errorQuery(error), error);
  // Code paths and invisible characters.
  assert.equal(
    errorQuery("the trait `serde::Deserialize` is not implemented"),
    "the trait `serde::Deserialize` is not implemented",
  );
  assert.equal(errorQuery("Type\u200bError:\u202e bad"), "Type Error: bad");
});

test("search endpoints and results are validated and cleaned", () => {
  assert.equal(
    checkSearchEndpoint("https://search.example/search?q={query}&format=json"),
    "https://search.example",
  );
  assert.equal(checkSearchEndpoint("http://x/{query}"), "http://x");
  assert.equal(checkSearchEndpoint("http://x#{query}"), "http://x");
  assert.equal(
    checkSearchEndpoint("https://search.example?{query}"),
    "https://search.example",
  );
  for (const template of [
    "https://search.example/search?q=static",
    "ftp://search.example/?q={query}",
    "https://user:pw@search.example/?q={query}",
    "not a url {query}",
    // The query must never choose the host, port or credentials.
    "http://{query}:9/s",
    "http://127.0.0.{query}/",
    "http://h{query}st/",
    "http://u:{query}@h/",
  ])
    assert.throws(
      () => checkSearchEndpoint(template),
      refused("bad_url"),
      template,
    );

  const control = String.fromCharCode(27) + "[2J" + String.fromCharCode(0x202e);
  const results = parseSearchResults(
    JSON.stringify({
      results: [
        {
          url: "https://a.example/1",
          title: `A${control}`,
          content: "x".repeat(400),
        },
        { url: "https://a.example/1", title: "duplicate", content: "" },
        { url: "javascript:alert(1)", title: "script", content: "" },
        { url: "https://u:p@b.example/", title: "creds", content: "" },
        { url: 42, title: "bad", content: "" },
        { url: "https://c.example/2", title: "t".repeat(300), content: "ok" },
        { url: "https://d.example/3", title: "D", content: "d" },
      ],
    }),
    2,
  );
  assert.deepEqual(
    results.map((item) => item.url),
    ["https://a.example/1", "https://c.example/2"],
  );
  assert.equal(results[0]?.title, "A [2J");
  assert.equal(results[0].snippet.length, 300);
  assert.equal(results[1]?.title.length, 200);
  // Fragment variants are duplicates; only the first 50 items are examined.
  const many = parseSearchResults(
    JSON.stringify({
      results: [
        { url: "https://e.example/p#one", title: "E", content: "" },
        { url: "https://e.example/p#two", title: "E2", content: "" },
        ...Array.from({ length: 48 }, () => ({ url: 1 })),
        { url: "https://late.example/", title: "late", content: "" },
      ],
    }),
    10,
  );
  assert.deepEqual(
    many.map((item) => item.url),
    ["https://e.example/p#one"],
  );
  for (const body of ["not json", "{}", '{"results":"x"}'])
    assert.throws(
      () => parseSearchResults(body, 5),
      refused("search_failed"),
      body,
    );
});

async function serve(
  context: TestContext,
  handler: Parameters<typeof createServer>[1],
): Promise<string> {
  const server: Server = createServer(handler);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  context.after(
    () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => {
          resolve();
        });
      }),
  );
  return `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`;
}

function searchServer(context: TestContext) {
  return serve(context, (request, response) => {
    const url = new URL(request.url ?? "/", "http://local");
    const base = `http://${request.headers.host ?? ""}`;
    if (url.pathname === "/search") {
      response.setHeader("content-type", "application/json");
      response.end(
        JSON.stringify({
          results: [
            {
              url: `${base}/page`,
              title: "Local page",
              content: url.searchParams.get("q"),
            },
          ],
        }),
      );
    } else if (url.pathname === "/html") {
      response.setHeader("content-type", "text/html");
      response.end("<p>not json</p>");
    } else if (url.pathname === "/redirect") {
      response.writeHead(302, { location: "/search?q=x" });
      response.end();
    } else if (url.pathname === "/big") {
      response.setHeader("content-type", "application/json");
      response.end(`{"results":[],"pad":"${"x".repeat(1024 * 1024 + 10)}"}`);
    } else if (url.pathname === "/page") {
      response.setHeader("content-type", "text/plain");
      response.end("A private page that must never be read.");
    } else {
      response.writeHead(404);
      response.end();
    }
  });
}

test("the endpoint client uses the private exemption only for its own origin", async (context) => {
  const base = await searchServer(context);
  const search = createEndpointSearch({
    endpoint: `${base}/search?q={query}&format=json`,
    allowPrivateEndpoint: true,
  });
  const results = await search("socket hang up & retry", 5);
  assert.deepEqual(results, [
    {
      title: "Local page",
      url: `${base}/page`,
      snippet: "socket hang up & retry",
    },
  ]);
  for (const path of ["/html", "/redirect", "/big", "/missing"])
    await assert.rejects(
      createEndpointSearch({
        endpoint: `${base}${path}?q={query}`,
        allowPrivateEndpoint: true,
      })("x", 5),
      refused("search_failed"),
      path,
    );
  await assert.rejects(
    createEndpointSearch({ endpoint: `${base}/search?q={query}` })("x", 5),
    refused("blocked_address"),
  );

  // The exemption covers the endpoint only: its private result URL is
  // fetched with the full policy and refused, so nothing can be read.
  const client = await connect(context, createResearchServer({ search }));
  const resolved = await client.callTool({
    name: "resolve_stuck_error",
    arguments: { error: "Error: socket hang up" },
  });
  assert.equal(resolved.isError, true);
  assert.deepEqual(
    JSON.parse((resolved.content as { text: string }[])[0]?.text ?? ""),
    { error: "no_results" },
  );
});

async function connect(context: TestContext, server = createResearchServer()) {
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "search-test", version: "1.0.0" });
  context.after(async () => {
    await client.close();
    await server.close();
  });
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  return client;
}

test("search tools exist only when a provider is configured", async (context) => {
  const plain = await connect(context);
  assert.deepEqual(
    (await plain.listTools()).tools.map((tool) => tool.name),
    ["fetch_distilled"],
  );
  const search: SearchFunction = () => Promise.resolve([]);
  const withSearch = await connect(context, createResearchServer({ search }));
  const tools = (await withSearch.listTools()).tools;
  assert.deepEqual(tools.map((tool) => tool.name).sort(), [
    "fetch_distilled",
    "resolve_stuck_error",
    "web_search",
  ]);
  for (const tool of tools) {
    assert.equal(tool.annotations?.readOnlyHint, true, tool.name);
    assert.equal(tool.annotations.openWorldHint, true, tool.name);
  }
});

test("resolve_stuck_error combines readable sources within one budget", async (context) => {
  const pages: Record<string, FetchedPage | undefined> = {
    "https://a.example/": {
      url: "https://a.example/",
      finalUrl: "https://a.example/",
      contentType: "text/html",
      body: `<title>Fixing ECONNRESET</title>${"<p>filler unrelated</p>".repeat(300)}<p>ECONNRESET means the socket hung up; enable keepAlive.</p><pre>agent.keepAlive = true</pre>`,
    },
    "https://b.example/": {
      url: "https://b.example/",
      finalUrl: "https://b.example/",
      contentType: "text/plain",
      body: "Retry ECONNRESET with exponential backoff.\n\nUnrelated closing words.",
    },
  };
  let searched = "";
  const client = await connect(
    context,
    createResearchServer({
      search: (query, maxResults) => {
        searched = query;
        assert.equal(maxResults, 3);
        return Promise.resolve([
          { title: "A", url: "https://a.example/", snippet: "" },
          { title: "Down", url: "https://down.example/", snippet: "" },
          { title: "B", url: "https://b.example/", snippet: "" },
        ]);
      },
      fetchPage: (url) => {
        const page = pages[url];
        return page === undefined
          ? Promise.reject(new ResearchError("timeout"))
          : Promise.resolve(page);
      },
    }),
  );
  const result = await client.callTool({
    name: "resolve_stuck_error",
    arguments: {
      error:
        "Error: read ECONNRESET\n    at TLSWrap.onStreamRead (node:internal/stream_base_commons:217:20)",
      context: "keepAlive socket",
      maxTokens: 200,
    },
  });
  assert.equal(result.isError, undefined, JSON.stringify(result.content));
  const parsed = resolveStuckErrorOutputSchema.parse(result.structuredContent);
  assert.equal(searched, "Error: read ECONNRESET");
  assert.equal(parsed.query, searched);
  assert.deepEqual(parsed.sources, [
    { url: "https://a.example/", title: "Fixing ECONNRESET" },
    { url: "https://b.example/", title: "B" },
  ]);
  assert.equal(parsed.skipped, 1);
  assert.ok(parsed.text.length <= 200 * CHARS_PER_TOKEN);
  assert.match(parsed.text, /socket hung up/u);
  assert.match(parsed.text, /exponential backoff/u);
  assert.equal(parsed.text.includes("filler unrelated"), false);

  const failing = await connect(
    context,
    createResearchServer({
      search: () => Promise.reject(new Error("provider down")),
    }),
  );
  for (const [args, code] of [
    [{ error: "Error: something" }, "search_failed"],
    [{ error: "/only/a/path" }, "no_results"],
  ] as const) {
    const refusal = await failing.callTool({
      name: "resolve_stuck_error",
      arguments: args,
    });
    assert.deepEqual(
      JSON.parse((refusal.content as { text: string }[])[0]?.text ?? ""),
      { error: code },
    );
  }
  const empty = await connect(
    context,
    createResearchServer({ search: () => Promise.resolve([]) }),
  );
  const none = await empty.callTool({
    name: "web_search",
    arguments: { query: "anything" },
  });
  assert.deepEqual(webSearchOutputSchema.parse(none.structuredContent), {
    results: [],
  });
});

test("resolver output carries no control or bidi characters", async (context) => {
  const hidden = "\u202e\u200b\u2066" + String.fromCharCode(27);
  const client = await connect(
    context,
    createResearchServer({
      search: () =>
        Promise.resolve([
          { title: "T", url: "https://a.example/", snippet: "" },
        ]),
      fetchPage: (url) =>
        Promise.resolve({
          url,
          finalUrl: url,
          contentType: "text/html",
          body: `<title>Fix${hidden}ed</title><p>ECONNRESET${hidden} handled</p><pre>retry${hidden}()</pre>`,
        }),
    }),
  );
  const result = await client.callTool({
    name: "resolve_stuck_error",
    arguments: { error: "Error: read ECONNRESET" },
  });
  const parsed = resolveStuckErrorOutputSchema.parse(result.structuredContent);
  const text = JSON.stringify(parsed);
  for (const code of [0x202e, 0x200b, 0x2066, 27])
    assert.equal(text.includes(String.fromCharCode(code)), false, String(code));
  assert.match(parsed.text, /ECONNRESET handled/u);
});

test("the CLI serves search through a private endpoint but not private results", async (context) => {
  const base = await searchServer(context);
  const cli = fileURLToPath(new URL("../src/cli.js", import.meta.url));
  const client = new Client({ name: "search-cli", version: "1.0.0" });
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [
      cli,
      "research-server",
      "--search-endpoint",
      `${base}/search?q={query}&format=json`,
      "--search-endpoint-private",
    ],
    stderr: "pipe",
  });
  try {
    await client.connect(transport);
    const found = await client.callTool({
      name: "web_search",
      arguments: { query: "socket hang up" },
    });
    assert.equal(found.isError, undefined, JSON.stringify(found.content));
    assert.equal(
      webSearchOutputSchema.parse(found.structuredContent).results[0]?.url,
      `${base}/page`,
    );
    const resolved = await client.callTool({
      name: "resolve_stuck_error",
      arguments: { error: "Error: socket hang up" },
    });
    assert.deepEqual(
      JSON.parse((resolved.content as { text: string }[])[0]?.text ?? ""),
      { error: "no_results" },
    );
  } finally {
    await client.close();
  }
  for (const args of [
    ["--search-endpoint-private"],
    ["--search-endpoint", "https://search.example/static"],
    ["--search-endpoint"],
  ]) {
    const result = spawnSync(
      process.execPath,
      [cli, "research-server", ...args],
      {
        encoding: "utf8",
        timeout: 30_000,
      },
    );
    assert.notEqual(result.status, 0, args.join(" "));
  }
  for (const args of [
    ["--search-endpoint", "http://{query}:9/s"],
    ["--search-endpoint", "--search-endpoint-private"],
  ]) {
    const result = spawnSync(
      process.execPath,
      [cli, "research-server", ...args],
      { encoding: "utf8", timeout: 30_000 },
    );
    assert.notEqual(result.status, 0, args.join(" "));
    assert.match(result.stderr, /Usage: reprogate research-server/u);
  }
});
