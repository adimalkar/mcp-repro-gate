/**
 * Long versions of the resume tasks, shaped like real sessions that were
 * compacted several times. Each task's first session is spread through a
 * long session in a larger codebase: about twenty other requests, with
 * their reads, searches, test runs and edits, and one look-alike request
 * that is easy to confuse with the task's own rules. The task's request is
 * old by the time the session stops, so it is not among the newest.
 *
 * Measured on the author's own Claude Code sessions with two or more
 * compactions (aggregate counts only): median 23 requests, ~1,000 tool
 * calls, 1.7 MB of tool output, 3 compactions. These are smaller (about 20
 * requests, ~400 tool calls, ~620 KB of text), enough for three
 * compaction rounds at the chunk size the harness uses.
 */
import {
  TASKS,
  type Check,
  type ResumeTask,
  type Step,
} from "./handoff-resume-tasks.js";

const DOMAINS = [
  "billing",
  "inventory",
  "shipping",
  "accounts",
  "search",
  "reports",
  "notifications",
  "audit",
  "pricing",
  "catalog",
] as const;
const FIELDS = [
  "name",
  "status",
  "owner",
  "region",
  "tier",
  "currency",
  "label",
  "code",
];

// Deterministic, so every run of the benchmark sees the same sessions.
function random(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const title = (word: string) => word.charAt(0).toUpperCase() + word.slice(1);

function moduleSource(domain: string, index: number): string {
  const D = title(domain);
  const fields = FIELDS.slice(index % 3, (index % 3) + 5);
  const normalizers = fields
    .map(
      (field) => `function normalize${title(field)}(value) {
  if (value === undefined || value === null) return null;
  const text = String(value).trim();
  return text === "" ? null : text.slice(0, ${String(32 + index * 4)});
}
`,
    )
    .join("\n");
  const extra =
    domain === "catalog"
      ? `\n/** @deprecated Use listCatalogItems. */\nexport const listItems = listCatalogItems;\n`
      : domain === "reports"
        ? `\n/** Rows to tab-separated text. */\nexport function toTsv(rows) {\n  return rows.map((row) => row.join("\\t")).join("\\r\\n");\n}\n`
        : domain === "billing"
          ? `\nexport async function chargeCard(client, payment) {\n  const response = await client.post("/charges", payment);\n  if (!response.ok) throw new Error(\`charge failed: \${response.status}\`);\n  return response.body;\n}\n`
          : domain === "notifications"
            ? `\nexport function smtpPort(env = process.env) {\n  return Number(env.SMTP_PORT);\n}\n`
            : "";
  return `// ${D} service: storage-independent helpers for ${domain} records.
import { log } from "../lib/log.js";

const DEFAULT_LIMIT = ${String(20 + index * 5)};

${normalizers}
export function list${D}Items(store, { limit = DEFAULT_LIMIT, cursor = 0 } = {}) {
  const items = store.${domain}.slice(cursor, cursor + limit);
  log("${domain}.list", { count: items.length, cursor });
  return { items, next: cursor + items.length < store.${domain}.length ? cursor + items.length : null };
}

export function find${D}(store, id) {
  const found = store.${domain}.find((item) => item.id === id);
  return found === undefined ? null : { ...found };
}

export function create${D}(store, input) {
  const record = {
    id: \`${domain.slice(0, 3)}_\${String(store.${domain}.length + 1)}\`,
${fields.map((field) => `    ${field}: normalize${title(field)}(input.${field}),`).join("\n")}
  };
  store.${domain}.push(record);
  log("${domain}.create", { id: record.id });
  return record;
}

export function update${D}(store, id, patch) {
  const record = store.${domain}.find((item) => item.id === id);
  if (record === undefined) throw new Error(\`unknown ${domain} \${id}\`);
${fields.map((field) => `  if ("${field}" in patch) record.${field} = normalize${title(field)}(patch.${field});`).join("\n")}
  return { ...record };
}

export function summarize${D}(items) {
  const counts = {};
  for (const item of items) counts[item.status ?? "none"] = (counts[item.status ?? "none"] ?? 0) + 1;
  return { total: items.length, counts };
}
${extra}`;
}

function moduleTest(domain: string): string {
  const D = title(domain);
  return `import assert from "node:assert/strict";
import test from "node:test";
import { create${D}, find${D}, list${D}Items, summarize${D}, update${D} } from "../../src/services/${domain}.js";

const store = () => ({ ${domain}: [] });
test("${domain}: create and find", () => {
  const s = store();
  const record = create${D}(s, { status: " open " });
  assert.equal(find${D}(s, record.id)?.id, record.id);
});
test("${domain}: list pages", () => {
  const s = store();
  for (let i = 0; i < 3; i++) create${D}(s, {});
  assert.equal(list${D}Items(s, { limit: 2 }).items.length, 2);
});
test("${domain}: update unknown throws", () => {
  assert.throws(() => update${D}(store(), "x", {}));
});
test("${domain}: summarize counts", () => {
  assert.equal(summarize${D}([{ status: "a" }, {}]).total, 2);
});
`;
}

function moduleDoc(domain: string): string {
  const D = title(domain);
  return `# ${D}

The ${domain} service keeps ${domain} records in a plain store object, so it
can be tested without a database.

## Functions

- \`list${D}Items(store, { limit, cursor })\`: one page of records and the next cursor.
- \`find${D}(store, id)\`: a copy of one record, or null.
- \`create${D}(store, input)\`: adds a normalized record.
- \`update${D}(store, id, patch)\`: changes the given fields.
- \`summarize${D}(items)\`: counts by status.

## Notes

Values are trimmed and empty strings become null. Identifiers are prefixed
with \`${domain.slice(0, 3)}_\`. Logging goes through \`src/lib/log.js\`.
`;
}

/** The codebase every long task works in, besides its own files. */
export function codebase(): Record<string, string> {
  const files: Record<string, string> = {
    "src/lib/log.js": `export function log(event, fields = {}) {\n  if (process.env.APP_LOG === "1") console.log(JSON.stringify({ event, ...fields }));\n}\n`,
  };
  DOMAINS.forEach((domain, index) => {
    files[`src/services/${domain}.js`] = moduleSource(domain, index);
    files[`test/services/${domain}.test.js`] = moduleTest(domain);
    files[`docs/${domain}.md`] = moduleDoc(domain);
  });
  return files;
}

// Test output in the shape `node --test` prints it.
function testOutput(files: Record<string, string>): string {
  const names = Object.entries(files)
    .filter(([path]) => path.endsWith(".test.js"))
    .flatMap(([, source]) =>
      [...source.matchAll(/test\("([^"]+)"/gu)].map((match) => match[1] ?? ""),
    );
  return `> task@ test\n> node --test\n\n${names.map((name, i) => `✔ ${name} (${String(0.2 + ((i * 7) % 13) / 10)}ms)`).join("\n")}\nℹ tests ${String(names.length)}\nℹ suites 0\nℹ pass ${String(names.length)}\nℹ fail 0\nℹ cancelled 0\nℹ skipped 0\nℹ duration_ms ${String(180 + names.length * 3)}\n`;
}
function grepOutput(files: Record<string, string>, word: string): string {
  const lines: string[] = [];
  for (const [path, source] of Object.entries(files))
    source.split("\n").forEach((line, index) => {
      if (line.includes(word))
        lines.push(`${path}:${String(index + 1)}:${line}`);
    });
  return `${lines.join("\n")}\n`;
}

interface SideRequest {
  prompt: string;
  file: string;
  old: string;
  new: string;
  word: string;
}
function sideRequests(
  files: Record<string, string>,
  next: () => number,
): SideRequest[] {
  const requests: SideRequest[] = [];
  for (const domain of DOMAINS) {
    const D = title(domain);
    const path = `src/services/${domain}.js`;
    const source = files[path] ?? "";
    const limit = /const DEFAULT_LIMIT = (\d+);/u.exec(source)?.[1] ?? "20";
    requests.push({
      prompt: `In ${path}, raise the default page size for list${D}Items from ${limit} to ${String(Number(limit) + 10)}.`,
      file: path,
      old: `const DEFAULT_LIMIT = ${limit};`,
      new: `const DEFAULT_LIMIT = ${String(Number(limit) + 10)};`,
      word: `list${D}Items`,
    });
    requests.push({
      prompt: `Add a short JSDoc comment to find${D} in ${path} that says it returns a copy, or null when the id is unknown.`,
      file: path,
      old: `export function find${D}(store, id) {`,
      new: `/** A copy of the ${domain} record with this id, or null when it is unknown. */\nexport function find${D}(store, id) {`,
      word: `find${D}`,
    });
  }
  // Shuffle, deterministically, and keep nineteen.
  return requests
    .map((request) => ({ request, key: next() }))
    .sort((a, b) => a.key - b.key)
    .slice(0, 19)
    .map(({ request }) => request);
}

/** A request like the task's own, about another module, applied as asked. */
interface LookAlike {
  prompt: string;
  file: string;
  old: string;
  new: string;
}
const LOOK_ALIKES: Record<string, LookAlike> = {
  "retry-rules": {
    prompt:
      "Separate thing: in src/services/billing.js, make chargeCard retry up to 5 attempts in total, on any error including 4xx responses, with no delay between attempts. The payment gateway is flaky and idempotent.",
    file: "src/services/billing.js",
    old: `export async function chargeCard(client, payment) {\n  const response = await client.post("/charges", payment);\n  if (!response.ok) throw new Error(\`charge failed: \${response.status}\`);\n  return response.body;\n}`,
    new: `export async function chargeCard(client, payment) {\n  let lastError;\n  for (let attempt = 1; attempt <= 5; attempt++) {\n    try {\n      const response = await client.post("/charges", payment);\n      if (!response.ok) throw new Error(\`charge failed: \${response.status}\`);\n      return response.body;\n    } catch (error) {\n      lastError = error;\n    }\n  }\n  throw lastError;\n}`,
  },
  "frozen-decoy": {
    prompt:
      "In src/services/notifications.js, smtpPort should fall back to 2525 when SMTP_PORT is missing or empty.",
    file: "src/services/notifications.js",
    old: "  return Number(env.SMTP_PORT);",
    new: "  const port = Number(env.SMTP_PORT || 2525);\n  return Number.isInteger(port) && port > 0 ? port : 2525;",
  },
  "dead-end": {
    prompt:
      "In src/services/reports.js add parseReportDate(text) that returns a Date for an ISO timestamp string; using Date.parse there is fine, the strings always carry a zone.",
    file: "src/services/reports.js",
    old: "/** Rows to tab-separated text. */",
    new: "/** A Date for an ISO timestamp that carries its zone. */\nexport function parseReportDate(text) {\n  return new Date(Date.parse(text));\n}\n\n/** Rows to tab-separated text. */",
  },
  "rename-alias": {
    prompt:
      "Remove the deprecated listItems alias from src/services/catalog.js; nothing uses it any more.",
    file: "src/services/catalog.js",
    old: "\n/** @deprecated Use listCatalogItems. */\nexport const listItems = listCatalogItems;\n",
    new: "\n",
  },
  "csv-rate-limit": {
    prompt:
      "toTsv in src/services/reports.js should end lines with LF, not CRLF; the downstream tool is Unix-only.",
    file: "src/services/reports.js",
    old: '.join("\\r\\n");',
    new: '.join("\\n");',
  },
  "ordered-plan": {
    prompt:
      "Add migrations/003_projects_name_index.sql that creates an index on projects(name).",
    file: "migrations/003_projects_name_index.sql",
    old: "",
    new: "CREATE INDEX projects_name ON projects(name);\n",
  },
};

function applyEdit(
  files: Record<string, string>,
  file: string,
  old: string,
  replacement: string,
) {
  if (old === "") {
    files[file] = replacement;
    return;
  }
  const current = files[file];
  if (!current?.includes(old))
    throw new Error(`long task: ${file} edit does not apply`);
  files[file] = current.replace(old, replacement);
}

/** The long version of a task: same goal, buried in a long session. */
export function lengthen(task: ResumeTask, seed: number): ResumeTask {
  const next = random(seed);
  const base = { ...codebase(), ...task.base };
  const files = { ...base };
  const steps: Step[] = [];
  const read = (path: string) => steps.push({ kind: "read", path });
  const bash = (command: string, output: string) =>
    steps.push({ kind: "bash", command, output, exit: 0 });
  const others = Object.keys(files).filter(
    (path) => path.startsWith("src/services/") || path.startsWith("docs/"),
  );
  const explore = (count: number) => {
    for (let i = 0; i < count; i++)
      read(others[Math.floor(next() * others.length)] ?? "src/lib/log.js");
  };
  const block = (
    prompt: string,
    file: string,
    old: string,
    replacement: string,
    word: string,
  ) => {
    steps.push({ kind: "prompt", text: prompt });
    bash(`grep -rn "${word}" src test docs`, grepOutput(files, word));
    if (files[file] !== undefined) read(file);
    explore(7 + Math.floor(next() * 4));
    if (old === "") {
      applyEdit(files, file, old, replacement);
      steps.push({ kind: "write", path: file, content: replacement });
    } else {
      applyEdit(files, file, old, replacement);
      steps.push({ kind: "edit", path: file, old, new: replacement });
    }
    bash("npm test", testOutput(files));
    explore(4 + Math.floor(next() * 3));
    bash("npm test", testOutput(files));
    bash(
      "git diff --stat",
      ` ${file} | 2 +-\n 1 file changed, 1 insertion(+), 1 deletion(-)\n`,
    );
    steps.push({
      kind: "say",
      text: `Done: ${prompt.split(":")[0]?.slice(0, 80) ?? "change"}. Tests pass.`,
    });
  };

  // The task's own steps: its first request opens the session, its last
  // two steps close it, and the rest are spread in order between blocks.
  const own = task.session;
  const middle = own.slice(1, -2);
  const tail = own.slice(-2);
  const applyOwn = (step: Step) => {
    if (step.kind === "write") files[step.path] = step.content;
    if (step.kind === "edit") applyEdit(files, step.path, step.old, step.new);
    steps.push(step);
  };
  const first = own[0];
  if (first === undefined) throw new Error(`${task.id}: empty session`);
  applyOwn(first);
  const sides = sideRequests(files, next);
  const lookAlike = LOOK_ALIKES[task.id];
  if (lookAlike === undefined)
    throw new Error(`${task.id}: no look-alike request`);
  const blocks = sides.length + 1;
  const lookAt = Math.floor(blocks * 0.6);
  let ownIndex = 0;
  for (let b = 0; b < blocks; b++) {
    // Own steps go into the first two thirds, so the request ages.
    while (
      ownIndex < middle.length &&
      ownIndex < Math.ceil(((b + 1) / Math.ceil(blocks * 0.66)) * middle.length)
    )
      applyOwn(middle[ownIndex++] ?? first);
    if (b === lookAt)
      block(
        lookAlike.prompt,
        lookAlike.file,
        lookAlike.old,
        lookAlike.new,
        lookAlike.file.split("/").pop()?.replace(/\..*$/u, "") ?? "src",
      );
    else {
      const side = sides[b > lookAt ? b - 1 : b];
      if (side !== undefined)
        block(side.prompt, side.file, side.old, side.new, side.word);
    }
  }
  while (ownIndex < middle.length) applyOwn(middle[ownIndex++] ?? first);
  for (const step of tail) applyOwn(step);

  const sessionState = { ...files };
  const lookAlikeFile = lookAlike.file;
  const extraChecks: Check[] = [
    {
      name: "look-alike request left as the user asked",
      pass: (read) => read(lookAlikeFile) === sessionState[lookAlikeFile],
    },
  ];
  // Checks that assumed a small repository.
  const checks = task.checks
    .filter(
      (check) =>
        check.name !== "a test was added" &&
        check.name !== "exactly one new migration, unchanged",
    )
    .concat(
      task.id === "frozen-decoy"
        ? [
            {
              name: "a test for the loader was added",
              pass: (read, list) =>
                list("**").some(
                  (file) =>
                    file.endsWith(".test.js") &&
                    !file.startsWith("test/services/") &&
                    !file.startsWith("test/hidden-") &&
                    (read(file) ?? "").includes("config/load.js"),
                ),
            },
          ]
        : [],
      task.id === "ordered-plan"
        ? [
            {
              name: "exactly one archived migration, unchanged",
              pass: (read, list) => {
                const archived = list("migrations").filter((file) =>
                  (read(`migrations/${file}`) ?? "").includes("archived"),
                );
                return (
                  archived.length === 1 &&
                  archived[0] === "002_archived.sql" &&
                  read("migrations/002_archived.sql") ===
                    sessionState["migrations/002_archived.sql"]
                );
              },
            },
          ]
        : [],
      extraChecks,
    );
  return { ...task, id: `${task.id}-long`, base, session: steps, checks };
}

export const LONG_TASKS: ResumeTask[] = TASKS.map((task, index) =>
  lengthen(task, 1000 + index),
);
