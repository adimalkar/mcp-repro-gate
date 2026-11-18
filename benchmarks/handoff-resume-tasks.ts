/**
 * Scripted resume tasks for the handoff A/B benchmark. Each task is a small
 * Node project, and a first session that did part of the work and stopped.
 * The information a resuming agent needs is in that session's transcript:
 * the user's exact rules, a failed approach, a frozen decoy file, work
 * already done. Hidden tests and checks score the result.
 */

export type Step =
  | { kind: "prompt"; text: string }
  | { kind: "say"; text: string }
  | { kind: "read"; path: string }
  | { kind: "bash"; command: string; output: string; exit: number }
  | { kind: "write"; path: string; content: string }
  | { kind: "edit"; path: string; old: string; new: string };

export interface Check {
  name: string;
  /** Reads files of the finished repository by relative path. */
  pass: (
    read: (path: string) => string | undefined,
    list: (dir: string) => string[],
  ) => boolean;
}

export interface ResumeTask {
  id: string;
  /** Committed before the first session started. */
  base: Record<string, string>;
  session: Step[];
  /** How the first session ended: killed with no hook, or a rate limit. */
  stop: "killed" | "rate_limit";
  /** Paths whose edit counts as working on the task. */
  targets: string[];
  /** Hidden test files, added only to score the result. */
  hidden: Record<string, string>;
  /** Checks beyond the tests: constraints, decoys, redone work. */
  checks: Check[];
  /** A known-good finish, to validate the scoring. Paths to final content. */
  reference: Record<string, string>;
}

const pkg = (test = "node --test") =>
  `${JSON.stringify({ name: "task", private: true, type: "module", scripts: { test } }, null, 2)}\n`;

const HTTP_BASE = `export class HttpError extends Error {
  constructor(status, url) {
    super(\`HTTP \${status} for \${url}\`);
    this.status = status;
  }
}

export async function fetchJson(url, options = {}) {
  const { fetchImpl = fetch } = options;
  const response = await fetchImpl(url);
  if (!response.ok) throw new HttpError(response.status, url);
  return response.json();
}
`;
const HTTP_PARTIAL = `export class HttpError extends Error {
  constructor(status, url) {
    super(\`HTTP \${status} for \${url}\`);
    this.status = status;
  }
}

export async function fetchJson(url, options = {}) {
  const { fetchImpl = fetch, sleep = (ms) => new Promise((r) => setTimeout(r, ms)) } = options;
  for (let attempt = 1; ; attempt++) {
    const response = await fetchImpl(url);
    if (response.ok) return response.json();
    if (response.status >= 500 && attempt < 3) {
      await sleep(100 * attempt);
      continue;
    }
    throw new HttpError(response.status, url);
  }
}
`;
const HTTP_REFERENCE = `export class HttpError extends Error {
  constructor(status, url) {
    super(\`HTTP \${status} for \${url}\`);
    this.status = status;
  }
}

export async function fetchJson(url, options = {}) {
  const { fetchImpl = fetch, sleep = (ms) => new Promise((r) => setTimeout(r, ms)) } = options;
  for (let attempt = 1; ; attempt++) {
    let response;
    try {
      response = await fetchImpl(url);
    } catch (error) {
      if (error?.code === "ECONNRESET" && attempt < 3) {
        await sleep(100 * attempt);
        continue;
      }
      throw error;
    }
    if (response.ok) return response.json();
    if (response.status >= 500 && attempt < 3) {
      await sleep(100 * attempt);
      continue;
    }
    throw new HttpError(response.status, url);
  }
}
`;
const HTTP_VISIBLE_TEST = `import assert from "node:assert/strict";
import test from "node:test";
import { fetchJson } from "../src/http.js";

const ok = (body) => ({ ok: true, status: 200, json: async () => body });
const fail = (status) => ({ ok: false, status, json: async () => ({}) });

test("returns the JSON body", async () => {
  assert.deepEqual(await fetchJson("u", { fetchImpl: async () => ok({ a: 1 }) }), { a: 1 });
});

test("retries a 503", async () => {
  const replies = [fail(503), ok({ a: 2 })];
  const body = await fetchJson("u", { fetchImpl: async () => replies.shift(), sleep: async () => {} });
  assert.deepEqual(body, { a: 2 });
});
`;
const HTTP_SESSION_TEST = `${HTTP_VISIBLE_TEST}
test("retries ECONNRESET", async () => {
  let calls = 0;
  const fetchImpl = async () => {
    calls++;
    if (calls === 1) throw Object.assign(new Error("socket hang up"), { code: "ECONNRESET" });
    return ok({ a: 3 });
  };
  assert.deepEqual(await fetchJson("u", { fetchImpl, sleep: async () => {} }), { a: 3 });
});
`;
const HTTP_HIDDEN = `import assert from "node:assert/strict";
import test from "node:test";
import { fetchJson, HttpError } from "../src/http.js";

const ok = (body) => ({ ok: true, status: 200, json: async () => body });
const fail = (status) => ({ ok: false, status, json: async () => ({}) });
const reset = () => Object.assign(new Error("reset"), { code: "ECONNRESET" });
function counting(replies) {
  const state = { calls: 0, sleeps: [] };
  return {
    state,
    options: {
      fetchImpl: async () => {
        state.calls++;
        const reply = replies.shift();
        if (reply instanceof Error) throw reply;
        return reply;
      },
      sleep: async (ms) => { state.sleeps.push(ms); },
    },
  };
}

test("hidden: three attempts in total for 5xx, then HttpError", async () => {
  const c = counting([fail(500), fail(502), fail(503), ok({})]);
  await assert.rejects(fetchJson("u", c.options), (e) => e instanceof HttpError && e.status === 503);
  assert.equal(c.state.calls, 3);
  assert.deepEqual(c.state.sleeps, [100, 200]);
});
test("hidden: 4xx is never retried", async () => {
  const c = counting([fail(404), ok({})]);
  await assert.rejects(fetchJson("u", c.options), (e) => e instanceof HttpError && e.status === 404);
  assert.equal(c.state.calls, 1);
});
test("hidden: ECONNRESET is retried up to three attempts", async () => {
  const c = counting([reset(), reset(), ok({ x: 1 })]);
  assert.deepEqual(await fetchJson("u", c.options), { x: 1 });
  const d = counting([reset(), reset(), reset(), ok({})]);
  await assert.rejects(fetchJson("u", d.options), (e) => e.code === "ECONNRESET");
  assert.equal(d.state.calls, 3);
});
test("hidden: other network errors are not retried", async () => {
  const c = counting([Object.assign(new Error("refused"), { code: "ECONNREFUSED" }), ok({})]);
  await assert.rejects(fetchJson("u", c.options), (e) => e.code === "ECONNREFUSED");
  assert.equal(c.state.calls, 1);
});
`;

const LOADER = (marker: string) => `// ${marker}
export function loadConfig(env = process.env) {
  return {
    host: env.HOST || "0.0.0.0",
    port: parseInt(env.PORT ?? "3000", 10),
  };
}
`;
const LOADER_FIXED = `// Config loader used by the server.
export function loadConfig(env = process.env) {
  const port = parseInt(env.PORT ?? "", 10);
  return {
    host: env.HOST || "0.0.0.0",
    port: Number.isInteger(port) && port > 0 ? port : 3000,
  };
}
`;
const LOADER_HIDDEN = `import assert from "node:assert/strict";
import test from "node:test";
import { loadConfig } from "../src/config/load.js";

test("hidden: empty or invalid PORT falls back to 3000", () => {
  assert.equal(loadConfig({ PORT: "" }).port, 3000);
  assert.equal(loadConfig({}).port, 3000);
  assert.equal(loadConfig({ PORT: "abc" }).port, 3000);
  assert.equal(loadConfig({ PORT: "8080" }).port, 8080);
});
`;

const WEEK_STUB = `/** The UTC Date of the Monday that starts ISO week \`week\` of \`year\`. */
export function isoWeekStart(year, week) {
  throw new Error("not implemented");
}
`;
const WEEK_LOCAL = `/** The UTC Date of the Monday that starts ISO week \`week\` of \`year\`. */
export function isoWeekStart(year, week) {
  const jan4 = new Date(\`\${year}-01-04T00:00:00\`);
  const monday = new Date(jan4);
  monday.setDate(jan4.getDate() - ((jan4.getDay() + 6) % 7) + (week - 1) * 7);
  return monday;
}
`;
const WEEK_REFERENCE = `/** The UTC Date of the Monday that starts ISO week \`week\` of \`year\`. */
export function isoWeekStart(year, week) {
  const jan4 = Date.UTC(year, 0, 4);
  const weekday = (new Date(jan4).getUTCDay() + 6) % 7;
  const start = jan4 - weekday * 86400000;
  const nextJan4 = Date.UTC(year + 1, 0, 4);
  const nextStart = nextJan4 - ((new Date(nextJan4).getUTCDay() + 6) % 7) * 86400000;
  const weeks = Math.round((nextStart - start) / (7 * 86400000));
  if (!Number.isInteger(week) || week < 1 || week > weeks)
    throw new RangeError(\`\${year} has \${weeks} ISO weeks\`);
  return new Date(start + (week - 1) * 7 * 86400000);
}
`;
const WEEK_VISIBLE_TEST = `import assert from "node:assert/strict";
import test from "node:test";
import { isoWeekStart } from "../src/week.js";

test("week 1 of 2027 starts on 2027-01-04", () => {
  assert.equal(isoWeekStart(2027, 1).toISOString(), "2027-01-04T00:00:00.000Z");
});
`;
const WEEK_HIDDEN = `import assert from "node:assert/strict";
import test from "node:test";
import { isoWeekStart } from "../src/week.js";

test("hidden: Mondays in UTC across year boundaries", () => {
  assert.equal(isoWeekStart(2026, 1).toISOString(), "2025-12-29T00:00:00.000Z");
  assert.equal(isoWeekStart(2027, 1).toISOString(), "2027-01-04T00:00:00.000Z");
  assert.equal(isoWeekStart(2020, 53).toISOString(), "2020-12-28T00:00:00.000Z");
  assert.equal(isoWeekStart(2021, 10).toISOString(), "2021-03-08T00:00:00.000Z");
});
test("hidden: week 53 of a 52-week year is a RangeError", () => {
  assert.throws(() => isoWeekStart(2021, 53), RangeError);
});
`;

const CART = `/** Sum of quantity times unit price, in cents. */
export function computeTotal(items) {
  return items.reduce((sum, item) => sum + item.quantity * item.unitCents, 0);
}
`;
const CART_RENAMED = `/** Sum of quantity times unit price, in cents. */
export function sumLineItems(items) {
  return items.reduce((sum, item) => sum + item.quantity * item.unitCents, 0);
}
`;
const CART_REFERENCE = `${CART_RENAMED}
/** @deprecated Use sumLineItems. Kept for one release. */
export const computeTotal = sumLineItems;
`;
const INVOICE = (name: string) => `import { ${name} } from "./cart.js";

export function invoiceLine(customer, items) {
  return \`\${customer}: \${(${name}(items) / 100).toFixed(2)}\`;
}
`;
const REPORT = (name: string) => `import { ${name} } from "./cart.js";

export function dailyTotal(orders) {
  return orders.reduce((sum, order) => sum + ${name}(order.items), 0);
}
`;
const CART_TEST = (name: string) => `import assert from "node:assert/strict";
import test from "node:test";
import { ${name} } from "../src/cart.js";
import { invoiceLine } from "../src/invoice.js";
import { dailyTotal } from "../src/report.js";

const items = [{ quantity: 2, unitCents: 150 }, { quantity: 1, unitCents: 99 }];
test("sums line items", () => assert.equal(${name}(items), 399));
test("invoice line", () => assert.equal(invoiceLine("ada", items), "ada: 3.99"));
test("daily total", () => assert.equal(dailyTotal([{ items }, { items }]), 798));
`;
const CART_HIDDEN = `import assert from "node:assert/strict";
import test from "node:test";
import * as cart from "../src/cart.js";

test("hidden: sumLineItems is exported and computeTotal is the same function", () => {
  assert.equal(typeof cart.sumLineItems, "function");
  assert.equal(cart.computeTotal, cart.sumLineItems);
});
`;

const CSV_STUB = `/** Rows of strings or numbers to CSV text. */
export function toCsv(rows) {
  throw new Error("not implemented");
}
`;
const CSV_PARTIAL = `/** Rows of strings or numbers to CSV text. */
export function toCsv(rows) {
  return rows
    .map((row) =>
      row
        .map((value) => {
          const text = String(value);
          return text.includes(",") ? \`"\${text}"\` : text;
        })
        .join(","),
    )
    .join("\\n");
}
`;
const CSV_REFERENCE = `/** Rows of strings or numbers to CSV text (RFC 4180). */
export function toCsv(rows) {
  return rows
    .map((row) =>
      row
        .map((value) => {
          const text = value === null || value === undefined ? "" : String(value);
          return /[",\\r\\n]/.test(text) ? \`"\${text.replaceAll('"', '""')}"\` : text;
        })
        .join(","),
    )
    .map((line) => \`\${line}\\r\\n\`)
    .join("");
}
`;
const CSV_HIDDEN = `import assert from "node:assert/strict";
import test from "node:test";
import { toCsv } from "../src/export.js";

test("hidden: RFC 4180 quoting and CRLF line ends", () => {
  assert.equal(toCsv([["a", "b"], [1, 2]]), "a,b\\r\\n1,2\\r\\n");
  assert.equal(toCsv([["x,y", 'say "hi"', "two\\nlines", "cr\\rhere"]]),
    '"x,y","say ""hi""","two\\nlines","cr\\rhere"\\r\\n');
  assert.equal(toCsv([[null, undefined, 0]]), ",,0\\r\\n");
  assert.equal(toCsv([]), "");
});
`;

const SCHEMA = `export const projectSchema = {
  id: { type: "string" },
  name: { type: "string" },
};
`;
const SCHEMA_DONE = `export const projectSchema = {
  id: { type: "string" },
  name: { type: "string" },
  archived: { type: "boolean", default: false },
};
`;
const API = `export function listProjects(db, query = {}) {
  return db.projects.slice();
}
`;
const API_REFERENCE = `export function listProjects(db, query = {}) {
  return query.includeArchived === "1"
    ? db.projects.slice()
    : db.projects.filter((project) => !project.archived);
}
`;
const MIGRATION =
  "ALTER TABLE projects ADD COLUMN archived BOOLEAN NOT NULL DEFAULT FALSE;\n";
const API_HIDDEN = `import assert from "node:assert/strict";
import test from "node:test";
import { listProjects } from "../src/api.js";

const db = { projects: [{ id: "a", archived: false }, { id: "b", archived: true }, { id: "c" }] };
test("hidden: archived projects are hidden unless includeArchived=1", () => {
  assert.deepEqual(listProjects(db).map((p) => p.id), ["a", "c"]);
  assert.deepEqual(listProjects(db, {}).map((p) => p.id), ["a", "c"]);
  assert.deepEqual(listProjects(db, { includeArchived: "1" }).map((p) => p.id), ["a", "b", "c"]);
});
`;

const has = (
  read: (path: string) => string | undefined,
  path: string,
  pattern: RegExp,
) => pattern.test(read(path) ?? "");

export const TASKS: ResumeTask[] = [
  {
    id: "retry-rules",
    base: {
      "package.json": pkg(),
      "src/http.js": HTTP_BASE,
      "test/http.test.js": HTTP_VISIBLE_TEST,
    },
    session: [
      {
        kind: "prompt",
        text: "Add retries to fetchJson in src/http.js. Rules: at most 3 attempts in total; retry only on HTTP 5xx responses and on network errors whose code is ECONNRESET, and never on 4xx or any other error; wait 100 ms times the attempt number between attempts, through an injectable `sleep` option so tests do not wait; keep the exported signature fetchJson(url, options) and HttpError unchanged.",
      },
      { kind: "read", path: "src/http.js" },
      {
        kind: "say",
        text: "I'll add a retry loop for 5xx first, then network errors.",
      },
      { kind: "write", path: "src/http.js", content: HTTP_PARTIAL },
      {
        kind: "bash",
        command: "npm test",
        output:
          "> task@ test\n> node --test\n\n✔ returns the JSON body\n✔ retries a 503\nℹ tests 2\nℹ pass 2\nℹ fail 0\n",
        exit: 0,
      },
      { kind: "write", path: "test/http.test.js", content: HTTP_SESSION_TEST },
      {
        kind: "bash",
        command: "npm test",
        output:
          "Exit code 1\n> task@ test\n> node --test\n\n✔ returns the JSON body\n✔ retries a 503\n✖ retries ECONNRESET\n  Error: socket hang up\n      at fetchImpl (test/http.test.js:21:28)\nℹ tests 3\nℹ pass 2\nℹ fail 1\n",
        exit: 1,
      },
      {
        kind: "say",
        text: "The ECONNRESET case throws out of fetchImpl before the loop sees a response. I need to catch it around the call.",
      },
    ],
    stop: "killed",
    targets: ["src/http.js"],
    hidden: { "test/hidden-http.test.js": HTTP_HIDDEN },
    checks: [
      {
        name: "signature kept",
        pass: (read) =>
          has(
            read,
            "src/http.js",
            /export async function fetchJson\(url, options = \{\}\)/u,
          ) && has(read, "src/http.js", /export class HttpError/u),
      },
    ],
    reference: { "src/http.js": HTTP_REFERENCE },
  },
  {
    id: "frozen-decoy",
    base: {
      "package.json": pkg(),
      "src/config/load.js": LOADER("Config loader used by the server."),
      "src/legacy/config/load.js": LOADER("Config loader for the v1 branch."),
      "src/server.js": `import { loadConfig } from "./config/load.js";\n\nexport const config = loadConfig();\n`,
    },
    session: [
      {
        kind: "prompt",
        text: "With PORT set to an empty string the server listens on NaN. Fix it in the config loader we use, src/config/load.js, so that an empty, missing or non-numeric PORT falls back to 3000. Everything under src/legacy/ is frozen for the v1 branch: do not touch any file there. Add a test for the fix.",
      },
      {
        kind: "bash",
        command: 'grep -rn "parseInt(env.PORT" src',
        output:
          'src/config/load.js:5:    port: parseInt(env.PORT ?? "3000", 10),\nsrc/legacy/config/load.js:5:    port: parseInt(env.PORT ?? "3000", 10),\n',
        exit: 0,
      },
      { kind: "read", path: "src/config/load.js" },
      { kind: "read", path: "src/legacy/config/load.js" },
      {
        kind: "bash",
        command:
          'node -e \'import("./src/config/load.js").then(m => console.log(m.loadConfig({ PORT: "" })))\'',
        output: "{ host: '0.0.0.0', port: NaN }\n",
        exit: 0,
      },
      {
        kind: "say",
        text: "Reproduced: `??` keeps the empty string, so parseInt returns NaN. The two loaders are identical; only src/config/load.js gets the fix.",
      },
    ],
    stop: "killed",
    targets: ["src/config/load.js"],
    hidden: { "test/hidden-config.test.js": LOADER_HIDDEN },
    checks: [
      {
        name: "legacy loader untouched",
        pass: (read) =>
          read("src/legacy/config/load.js") ===
          LOADER("Config loader for the v1 branch."),
      },
      {
        // Anywhere: the user did not say where. Before 2026-11-17's measured
        // run was scored, this looked only in test/, and failed five runs
        // that added src/config/load.test.js.
        name: "a test was added",
        pass: (_read, list) =>
          list("**").some((file) => file.endsWith(".test.js")),
      },
    ],
    reference: {
      "src/config/load.js": LOADER_FIXED,
      "test/config.test.js": LOADER_HIDDEN.replaceAll("hidden: ", ""),
    },
  },
  {
    id: "dead-end",
    base: {
      "package.json": pkg("TZ=Europe/Berlin node --test"),
      "src/week.js": WEEK_STUB,
      "test/week.test.js": WEEK_VISIBLE_TEST,
    },
    session: [
      {
        kind: "prompt",
        text: "Implement isoWeekStart(year, week) in src/week.js: it returns the UTC Date of the Monday that starts ISO week `week` of `year`. There is a test in test/week.test.js.",
      },
      { kind: "write", path: "src/week.js", content: WEEK_LOCAL },
      {
        kind: "bash",
        command: "npm test",
        output:
          "Exit code 1\n> task@ test\n> TZ=Europe/Berlin node --test\n\n✖ week 1 of 2027 starts on 2027-01-04\n  AssertionError: Expected values to be strictly equal:\n  + actual - expected\n  + '2027-01-03T23:00:00.000Z'\n  - '2027-01-04T00:00:00.000Z'\nℹ tests 1\nℹ pass 0\nℹ fail 1\n",
        exit: 1,
      },
      {
        kind: "say",
        text: "Off by one hour: parsing the string and setDate work in local time (Europe/Berlin).",
      },
      {
        kind: "prompt",
        text: "Don't rely on local time or on parsing date strings at all; compute it with Date.UTC arithmetic only. Also, week 53 must throw a RangeError for years that only have 52 ISO weeks.",
      },
      {
        kind: "say",
        text: "Understood. I'll rewrite isoWeekStart with Date.UTC and getUTCDay, and add the 52/53-week check.",
      },
    ],
    stop: "killed",
    targets: ["src/week.js"],
    hidden: { "test/hidden-week.test.js": WEEK_HIDDEN },
    checks: [
      {
        name: "no local-time or string-parsing date code",
        pass: (read) => {
          const source = read("src/week.js") ?? "";
          return (
            !/\.getDay\(|\.setDate\(|\.getDate\(|new Date\(\s*[`'"]|Date\.parse\(/u.test(
              source,
            ) && source.includes("Date.UTC(")
          );
        },
      },
    ],
    reference: { "src/week.js": WEEK_REFERENCE },
  },
  {
    id: "rename-alias",
    base: {
      "package.json": pkg(),
      "src/cart.js": CART,
      "src/invoice.js": INVOICE("computeTotal"),
      "src/report.js": REPORT("computeTotal"),
      "test/cart.test.js": CART_TEST("computeTotal"),
    },
    session: [
      {
        kind: "prompt",
        text: "Rename computeTotal to sumLineItems everywhere: src/cart.js, src/invoice.js, src/report.js and the tests. Keep computeTotal exported from src/cart.js as a deprecated alias for one release: the same function object, with a JSDoc @deprecated tag.",
      },
      {
        kind: "bash",
        command: "grep -rln computeTotal src test",
        output:
          "src/cart.js\nsrc/invoice.js\nsrc/report.js\ntest/cart.test.js\n",
        exit: 0,
      },
      { kind: "write", path: "src/cart.js", content: CART_RENAMED },
      {
        kind: "write",
        path: "src/invoice.js",
        content: INVOICE("sumLineItems"),
      },
      {
        kind: "bash",
        command: "npm test",
        output:
          "Exit code 1\n> task@ test\n> node --test\n\nfile:///task/src/report.js:1\nimport { computeTotal } from \"./cart.js\";\n         ^^^^^^^^^^^^\nSyntaxError: The requested module './cart.js' does not provide an export named 'computeTotal'\nℹ tests 1\nℹ pass 0\nℹ fail 1\n",
        exit: 1,
      },
      {
        kind: "say",
        text: "cart.js and invoice.js are renamed. report.js and the test still import computeTotal; next I'll update them.",
      },
    ],
    stop: "killed",
    targets: ["src/report.js", "test/cart.test.js", "src/cart.js"],
    hidden: { "test/hidden-cart.test.js": CART_HIDDEN },
    checks: [
      {
        name: "alias marked @deprecated",
        pass: (read) => has(read, "src/cart.js", /@deprecated/u),
      },
      {
        name: "no remaining computeTotal calls",
        pass: (read) =>
          !`${read("src/invoice.js") ?? ""}${read("src/report.js") ?? ""}`.includes(
            "computeTotal",
          ),
      },
    ],
    reference: {
      "src/cart.js": CART_REFERENCE,
      "src/report.js": REPORT("sumLineItems"),
      "test/cart.test.js": CART_TEST("sumLineItems"),
    },
  },
  {
    id: "csv-rate-limit",
    base: { "package.json": pkg(), "src/export.js": CSV_STUB },
    session: [
      {
        kind: "prompt",
        text: "Write toCsv(rows) in src/export.js. rows is an array of arrays of strings or numbers. Follow RFC 4180: a field containing a comma, a double quote, a CR or an LF is wrapped in double quotes; a double quote inside a field is written as two double quotes; every line ends with CRLF, including the last one; numbers are written with String(n); null and undefined become empty fields. An empty rows array gives an empty string.",
      },
      { kind: "say", text: "Starting with the field quoting." },
      { kind: "write", path: "src/export.js", content: CSV_PARTIAL },
      {
        kind: "write",
        path: "test/export.test.js",
        content: `import assert from "node:assert/strict";\nimport test from "node:test";\nimport { toCsv } from "../src/export.js";\n\ntest("quotes commas", () => {\n  assert.equal(toCsv([["x,y"]]).trim(), '"x,y"');\n});\n`,
      },
      {
        kind: "bash",
        command: "npm test",
        output:
          "> task@ test\n> node --test\n\n✔ quotes commas\nℹ tests 1\nℹ pass 1\nℹ fail 0\n",
        exit: 0,
      },
      {
        kind: "say",
        text: "Commas work. Next: escaping quotes, CR/LF fields, CRLF line ends and null handling.",
      },
    ],
    stop: "rate_limit",
    targets: ["src/export.js"],
    hidden: { "test/hidden-export.test.js": CSV_HIDDEN },
    checks: [],
    reference: { "src/export.js": CSV_REFERENCE },
  },
  {
    id: "ordered-plan",
    base: {
      "package.json": pkg(),
      "src/schema.js": SCHEMA,
      "src/api.js": API,
      "migrations/001_init.sql":
        "CREATE TABLE projects (id TEXT PRIMARY KEY, name TEXT NOT NULL);\n",
      "test/api.test.js": `import assert from "node:assert/strict";\nimport test from "node:test";\nimport { listProjects } from "../src/api.js";\n\ntest("lists projects", () => {\n  assert.equal(listProjects({ projects: [{ id: "a" }] }).length, 1);\n});\n`,
    },
    session: [
      {
        kind: "prompt",
        text: "Add project archiving in three steps, in this order: (1) add an `archived` boolean field to the schema in src/schema.js, default false; (2) add the migration migrations/002_archived.sql that adds the column with default false; there must be exactly one new migration file; (3) make listProjects in src/api.js hide archived projects unless the query has includeArchived=1.",
      },
      { kind: "write", path: "src/schema.js", content: SCHEMA_DONE },
      {
        kind: "write",
        path: "migrations/002_archived.sql",
        content: MIGRATION,
      },
      {
        kind: "bash",
        command: "npm test",
        output:
          "> task@ test\n> node --test\n\n✔ lists projects\nℹ tests 1\nℹ pass 1\nℹ fail 0\n",
        exit: 0,
      },
      {
        kind: "say",
        text: "Steps 1 and 2 are done: the schema has `archived` (default false) and migrations/002_archived.sql adds the column. Starting step 3 in src/api.js.",
      },
      { kind: "read", path: "src/api.js" },
    ],
    stop: "killed",
    targets: ["src/api.js"],
    hidden: { "test/hidden-api.test.js": API_HIDDEN },
    checks: [
      {
        name: "exactly one new migration, unchanged",
        pass: (read, list) => {
          const files = list("migrations").sort();
          return (
            files.length === 2 &&
            files[1] === "002_archived.sql" &&
            read("migrations/002_archived.sql") === MIGRATION
          );
        },
      },
      {
        name: "schema step kept",
        pass: (read) => read("src/schema.js") === SCHEMA_DONE,
      },
    ],
    reference: { "src/api.js": API_REFERENCE },
  },
];
