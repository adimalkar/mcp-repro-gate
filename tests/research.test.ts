import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import test, { type TestContext } from "node:test";
import { fileURLToPath } from "node:url";

import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";

import { isBlockedAddress } from "../src/research/address-policy.js";
import {
  CHARS_PER_TOKEN,
  distillHtml,
  distillPlain,
  selectRelevant,
} from "../src/research/distill.js";
import {
  ResearchError,
  checkUrl,
  fetchText,
  redirectAllowed,
} from "../src/research/fetch.js";
import {
  createResearchServer,
  fetchDistilledOutputSchema,
} from "../src/research/server.js";

const refused = (code: string) => (error: unknown) =>
  error instanceof ResearchError && error.code === code;

test("the address policy blocks private, special and embedded ranges", () => {
  for (const address of [
    "127.0.0.1",
    "10.1.2.3",
    "172.20.0.1",
    "192.168.1.1",
    "169.254.169.254",
    "100.64.0.1",
    "0.0.0.0",
    "198.18.0.1",
    "203.0.113.5",
    "224.0.0.1",
    "255.255.255.255",
    "::1",
    "::",
    "fe80::1",
    "fd00::1",
    "fec0::1",
    "ff02::1",
    "2001:db8::1",
    "2002:7f00:1::1",
    "::ffff:127.0.0.1",
    "::ffff:7f00:1",
    "64:ff9b::a9fe:a9fe",
    "not-an-ip",
  ])
    assert.equal(isBlockedAddress(address), true, address);
  for (const address of [
    "93.184.216.34",
    "8.8.8.8",
    "2606:4700::1111",
    "::ffff:8.8.8.8",
    "64:ff9b::808:808",
  ])
    assert.equal(isBlockedAddress(address), false, address);
});

test("URLs must be plain http(s) and inside the host allowlist", () => {
  for (const url of [
    "ftp://example.com/",
    "file:///etc/passwd",
    "javascript:alert(1)",
    "http://user:pw@example.com/",
    "not a url",
  ])
    assert.throws(() => checkUrl(url), refused("bad_url"), url);
  const allow = ["docs.example.com", ".example.org"];
  checkUrl("https://docs.example.com/a", allow);
  checkUrl("https://example.org/", allow);
  checkUrl("https://api.example.org/", allow);
  for (const url of ["https://example.com/", "https://evilexample.org/"])
    assert.throws(() => checkUrl(url, allow), refused("blocked_host"), url);
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

test("the default policy refuses loopback by address and by name", async (context) => {
  const base = await serve(context, (_request, response) => {
    response.end("never");
  });
  await assert.rejects(fetchText(`${base}/`), refused("blocked_address"));
  const port = new URL(base).port;
  await assert.rejects(
    fetchText(`http://localhost:${port}/`),
    refused("blocked_address"),
  );
});

test("fetching follows checked redirects and enforces type, size, status and time", async (context) => {
  const base = await serve(context, (request, response) => {
    const path = request.url ?? "/";
    if (path === "/page") {
      response.setHeader("content-type", "text/html; charset=utf-8");
      response.end("<title>Page</title><p>hello</p>");
    } else if (path === "/hop") {
      response.writeHead(302, { location: "/page" });
      response.end();
    } else if (path.startsWith("/loop")) {
      response.writeHead(302, {
        location: `/loop${path.length > 20 ? "" : "x"}`,
      });
      response.end();
    } else if (path === "/elsewhere") {
      response.writeHead(302, { location: "http://127.0.0.2:9/" });
      response.end();
    } else if (path === "/image") {
      response.setHeader("content-type", "image/png");
      response.end("png");
    } else if (path === "/big") {
      response.setHeader("content-type", "text/plain");
      response.write("x".repeat(600));
      response.end("x".repeat(600));
    } else if (path === "/declared") {
      response.writeHead(200, {
        "content-type": "text/plain",
        "content-length": "999999",
      });
      response.end("short");
    } else if (path === "/slow") {
      setTimeout(() => response.end("late"), 2_000);
    } else {
      response.writeHead(404);
      response.end("missing");
    }
  });
  // Test seam: allow only this loopback address; the CLI cannot set it.
  const options = {
    isAllowedAddress: (address: string) => address === "127.0.0.1",
  };
  const page = await fetchText(`${base}/hop`, options);
  assert.equal(page.finalUrl, `${base}/page`);
  assert.equal(page.contentType, "text/html");
  assert.match(page.body, /hello/u);
  await assert.rejects(
    fetchText(`${base}/loop`, options),
    refused("http_status"),
  );
  await assert.rejects(
    fetchText(`${base}/elsewhere`, options),
    refused("blocked_address"),
  );
  await assert.rejects(
    fetchText(`${base}/image`, options),
    refused("unsupported_type"),
  );
  await assert.rejects(
    fetchText(`${base}/big`, { ...options, maxBytes: 1000 }),
    refused("too_large"),
  );
  await assert.rejects(
    fetchText(`${base}/declared`, { ...options, maxBytes: 1000 }),
    refused("too_large"),
  );
  await assert.rejects(
    fetchText(`${base}/nope`, options),
    refused("http_status"),
  );
  await assert.rejects(
    fetchText(`${base}/slow`, { ...options, timeoutMs: 200 }),
    refused("timeout"),
  );
});

test("distillation removes page chrome, keeps code and decodes entities", () => {
  const distilled = distillHtml(
    `<html><head><title>Fix &amp; trace</title><script>evil()</script></head>
     <body><nav>Home | About</nav><header>Site</header>
     <article><h1>Fixing ECONNRESET</h1><p>Company history.</p>
     <p>ECONNRESET happens when the socket hangs up; set keepAlive.</p>
     <pre><code>const agent = new http.Agent({ keepAlive: true });</code></pre>
     <p>Quote &lt;b&gt; &#x27;x&#39; &#128512;</p></article>
     <aside>ads</aside><footer>(c) 2026</footer><!-- hidden --></body></html>`,
  );
  assert.equal(distilled.title, "Fix & trace");
  const texts = distilled.blocks.map((block) => block.text).join("\n");
  for (const gone of [
    "evil()",
    "Home | About",
    "Site",
    "ads",
    "(c) 2026",
    "hidden",
  ])
    assert.equal(texts.includes(gone), false, gone);
  assert.deepEqual(
    distilled.blocks.find((block) => block.kind === "code"),
    {
      kind: "code",
      text: "const agent = new http.Agent({ keepAlive: true });",
    },
  );
  assert.ok(texts.includes("Quote <b> 'x' \u{1F600}"));

  const selected = selectRelevant(
    distilled,
    "ECONNRESET keepAlive socket",
    4000,
  );
  assert.equal(selected.text.includes("Company history"), false);
  assert.ok(
    selected.text.indexOf("Fixing ECONNRESET") <
      selected.text.indexOf("keepAlive: true"),
  );
  const unmatched = selectRelevant(distilled, "zebra", 4000);
  assert.ok(unmatched.text.startsWith("Fixing ECONNRESET"));

  const plain = distillPlain(
    "Intro text\n\n```js\nconsole.log(1)\n```\n\nOutro",
  );
  assert.deepEqual(plain.blocks, [
    { kind: "text", text: "Intro text" },
    { kind: "code", text: "console.log(1)" },
    { kind: "text", text: "Outro" },
  ]);
});

test("selection never exceeds its character budget", () => {
  const html = Array.from(
    { length: 60 },
    (_, index) =>
      `<p>${"socket keepAlive retry ".repeat(index % 7)}paragraph ${String(index)} ${"filler ".repeat(40)}</p><pre>code ${String(index)} socket</pre>`,
  ).join("");
  const distilled = distillHtml(html);
  for (const budget of [0, 50, 199, 400, 1000, 2400, 4000]) {
    const { text, truncated } = selectRelevant(
      distilled,
      "socket keepAlive",
      budget,
    );
    assert.ok(
      text.length <= budget,
      `budget ${String(budget)}: ${String(text.length)}`,
    );
    assert.equal(truncated, true);
  }
});

async function connect(context: TestContext, server = createResearchServer()) {
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "research-test", version: "1.0.0" });
  context.after(async () => {
    await client.close();
    await server.close();
  });
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  return client;
}

test("fetch_distilled returns a bounded, relevant view and stable errors", async (context) => {
  const body = `<title>Guide</title>${"<p>unrelated filler text here</p>".repeat(200)}<p>The retry budget controls socket reuse.</p><pre>setRetryBudget(3)</pre>`;
  const client = await connect(
    context,
    createResearchServer({
      fetchPage: (url) =>
        url.includes("fail")
          ? Promise.reject(new ResearchError("too_large"))
          : Promise.resolve({
              url,
              finalUrl: `${url}#final`,
              contentType: "text/html",
              body,
            }),
    }),
  );
  const tool = (await client.listTools()).tools.find(
    (item) => item.name === "fetch_distilled",
  );
  assert.equal(tool?.annotations?.readOnlyHint, true);
  assert.equal(tool.annotations.openWorldHint, true);
  const result = await client.callTool({
    name: "fetch_distilled",
    arguments: {
      url: "https://example.com/guide",
      query: "retry budget",
      maxTokens: 100,
    },
  });
  assert.equal(result.isError, undefined);
  const parsed = fetchDistilledOutputSchema.parse(result.structuredContent);
  assert.equal(parsed.title, "Guide");
  assert.equal(parsed.finalUrl, "https://example.com/guide#final");
  assert.ok(parsed.text.length <= 100 * CHARS_PER_TOKEN);
  assert.ok(parsed.estimatedTokens <= 100);
  assert.match(parsed.text, /retry budget controls/u);
  assert.match(parsed.text, /setRetryBudget\(3\)/u);
  assert.equal(parsed.text.includes("unrelated filler"), false);
  assert.deepEqual(
    (result.content as { text: string }[]).map((item) => item.text),
    [parsed.text],
  );

  const failed = await client.callTool({
    name: "fetch_distilled",
    arguments: { url: "https://example.com/fail", query: "x" },
  });
  assert.equal(failed.isError, true);
  assert.deepEqual(
    JSON.parse((failed.content as { text: string }[])[0]?.text ?? ""),
    { error: "too_large" },
  );
  for (const maxTokens of [50, 1001])
    assert.equal(
      (
        await client.callTool({
          name: "fetch_distilled",
          arguments: { url: "https://example.com/", query: "x", maxTokens },
        })
      ).isError,
      true,
      String(maxTokens),
    );
});

test("the research-server CLI refuses loopback URLs and bad flags", async (context) => {
  const cli = fileURLToPath(new URL("../src/cli.js", import.meta.url));
  const client = new Client({ name: "research-cli", version: "1.0.0" });
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [cli, "research-server"],
    stderr: "pipe",
  });
  try {
    await client.connect(transport);
    const names = (await client.listTools()).tools.map((item) => item.name);
    assert.deepEqual(names, ["fetch_distilled"]);
    const result = await client.callTool({
      name: "fetch_distilled",
      arguments: { url: "http://127.0.0.1:9/", query: "x" },
    });
    assert.equal(result.isError, true);
    assert.deepEqual(
      JSON.parse((result.content as { text: string }[])[0]?.text ?? ""),
      { error: "blocked_address" },
    );
  } finally {
    await client.close();
  }
  context.diagnostic("CLI closed");
  const { spawnSync } = await import("node:child_process");
  const bad = spawnSync(
    process.execPath,
    [cli, "research-server", "--allow", "x"],
    {
      encoding: "utf8",
      timeout: 30_000,
    },
  );
  assert.notEqual(bad.status, 0);
  assert.match(bad.stderr, /Usage: reprogate research-server/u);
});

test("hostnames fetch through the all-addresses lookup and new embedded forms are blocked", async (context) => {
  for (const address of [
    "::127.0.0.1",
    "::7f00:1",
    "::a9fe:a9fe",
    "64:ff9b:1::7f00:1",
    "64:ff9b:1::808:808",
  ])
    assert.equal(isBlockedAddress(address), true, address);
  const base = await serve(context, (_request, response) => {
    response.setHeader("content-type", "text/plain");
    response.end("named host works");
  });
  const port = new URL(base).port;
  // Test seam: allow loopback so a real name resolves and connects.
  const page = await fetchText(`http://localhost:${port}/`, {
    isAllowedAddress: (address) => address === "127.0.0.1" || address === "::1",
  });
  assert.equal(page.body, "named host works");
});

test("refused responses are cut off instead of drained", async (context) => {
  let written = 0;
  let closed = false;
  const base = await serve(context, (request, response) => {
    const chunk = Buffer.alloc(64 * 1024, 120);
    response.writeHead(request.url === "/missing" ? 404 : 200, {
      "content-type": request.url === "/image" ? "image/png" : "text/plain",
    });
    const pump = () => {
      while (!closed && response.write(chunk)) written += chunk.length;
      if (!closed) response.once("drain", pump);
    };
    response.once("close", () => {
      closed = true;
    });
    pump();
  });
  const options = {
    isAllowedAddress: (address: string) => address === "127.0.0.1",
  };
  for (const path of ["/missing", "/image"]) {
    written = 0;
    closed = false;
    await assert.rejects(fetchText(`${base}${path}`, options));
    await new Promise((resolve) => setTimeout(resolve, 300));
    assert.equal(closed, true, path);
    assert.ok(written < 4 * 1024 * 1024, `${path}: ${String(written)} bytes`);
  }
});

test("redirects never downgrade from https to http", () => {
  const https = new URL("https://example.com/");
  const http = new URL("http://example.com/");
  assert.equal(redirectAllowed(https, http), false);
  assert.equal(redirectAllowed(http, https), true);
  assert.equal(redirectAllowed(https, new URL("https://example.org/")), true);
});

test("hostile pages distill in linear time", () => {
  const size = 1024 * 1024;
  const fence = String.fromCharCode(96).repeat(3);
  const inputs: [string, () => unknown][] = [
    ["many <", () => distillHtml("<".repeat(size))],
    ["unclosed pre", () => distillHtml(`<pre>${" ".repeat(size)}x</pre`)],
    ["unclosed tags", () => distillHtml("<p ".repeat(size / 3))],
    ["unclosed script", () => distillHtml("<script".repeat(size / 7))],
    ["unclosed comments", () => distillHtml("<!--".repeat(size / 4))],
    ["fence whitespace", () => distillPlain(`${fence}\n${" ".repeat(size)}x`)],
  ];
  for (const [name, run] of inputs) {
    const started = performance.now();
    const distilled = run() as ReturnType<typeof distillHtml>;
    selectRelevant(distilled, "socket keepAlive", 4000);
    const elapsed = performance.now() - started;
    assert.ok(elapsed < 3000, `${name}: ${elapsed.toFixed(0)} ms`);
  }
});

test("large relevant code is cut, and cuts never split a character", async (context) => {
  const code = `socket.setKeepAlive(true);\n${"line();\n".repeat(400)}`;
  const selected = selectRelevant(
    { title: "", blocks: [{ kind: "code", text: code }] },
    "socket keepAlive",
    600,
  );
  assert.ok(selected.text.length <= 600);
  assert.ok(selected.text.startsWith("```\nsocket.setKeepAlive"));
  assert.ok(selected.text.endsWith("\n```"));
  assert.equal(selected.truncated, true);

  const emoji = String.fromCodePoint(0x1f600);
  const cut = selectRelevant(
    {
      title: "",
      blocks: [{ kind: "text", text: `socket ${emoji.repeat(400)}` }],
    },
    "socket",
    301,
  );
  for (let index = 0; index < cut.text.length; index++) {
    const code = cut.text.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = cut.text.charCodeAt(index + 1);
      assert.ok(next >= 0xdc00 && next <= 0xdfff, "lone high surrogate");
    }
  }

  const longUrl = `https://example.com/${"a".repeat(5000)}`;
  const client = await connect(
    context,
    createResearchServer({
      fetchPage: (url) =>
        Promise.resolve({
          url,
          finalUrl: longUrl,
          contentType: "text/plain",
          body: "The socket keepAlive passage.",
        }),
    }),
  );
  const result = await client.callTool({
    name: "fetch_distilled",
    arguments: { url: "https://example.com/", query: "socket", maxTokens: 300 },
  });
  const parsed = fetchDistilledOutputSchema.parse(result.structuredContent);
  assert.equal(parsed.finalUrl, longUrl);
  assert.match(parsed.text, /socket keepAlive passage/u);
  assert.ok((parsed.text.split("\n")[0] ?? "").length <= 310);
});

test("research-server rejects allow-host values that are not hostnames", async () => {
  const { spawnSync } = await import("node:child_process");
  const cli = fileURLToPath(new URL("../src/cli.js", import.meta.url));
  for (const value of [".", "..", "-", "a..b", "-a.com", "a b"]) {
    const result = spawnSync(
      process.execPath,
      [cli, "research-server", "--allow-host", value],
      { encoding: "utf8", timeout: 30_000 },
    );
    assert.notEqual(result.status, 0, value);
    assert.match(result.stderr, /Usage: reprogate research-server/u, value);
  }
});

test("declarations and reserved IPv6 space are handled", () => {
  const distilled = distillHtml(
    '<?xml version="1.0"?><!DOCTYPE html><html><body><![CDATA[x]]><p>hi</p></body></html>',
  );
  assert.deepEqual(distilled.blocks, [{ kind: "text", text: "hi" }]);
  for (const address of ["::1:0:0:1", "::ffff:0:a00:1"])
    assert.equal(isBlockedAddress(address), true, address);
  for (const address of ["::ffff:8.8.8.8", "64:ff9b::808:808"])
    assert.equal(isBlockedAddress(address), false, address);
});
