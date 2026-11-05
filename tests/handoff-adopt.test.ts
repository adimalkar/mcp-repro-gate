import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  chmodSync,
  existsSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test, { type TestContext } from "node:test";
import { fileURLToPath } from "node:url";
import { Ajv2020 } from "ajv/dist/2020.js";
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";

import { sha256 } from "../src/digest.js";
import { createHandoffService, type HandoffService } from "../src/handoff.js";
import { NO_GOAL_FOUND, extractDocument } from "../src/handoff-adopt.js";
import { runHandoffCli } from "../src/handoff-cli.js";
import { handoffPermissionIssues } from "../src/handoff-filesystem.js";
import {
  HandoffError,
  MAX_ADOPTED_DOCUMENT_BYTES,
  renderHandoffRecord,
  type HandoffRecordV1,
} from "../src/handoff-contract.js";
import { createReproGateServer } from "../src/server.js";

const posix = { skip: process.platform === "win32" };
const statusInput = { handoffVersion: 1 };

const errorCode = (code: string) => (error: unknown) =>
  error instanceof HandoffError && error.code === code;

function git(root: string, ...args: string[]) {
  const result = spawnSync(
    "git",
    [
      "-C",
      root,
      "-c",
      "user.name=Test",
      "-c",
      "user.email=test@example.invalid",
      "-c",
      "commit.gpgsign=false",
      ...args,
    ],
    { encoding: "utf8" },
  );
  assert.equal(result.status, 0, result.stderr);
  return result.stdout;
}

function fixture(t: TestContext, scope?: "workspace" | "repository") {
  const scratch = realpathSync.native(
    mkdtempSync(join(tmpdir(), "reprogate-adopt-")),
  );
  const workspaceRoot = join(scratch, "workspace");
  const state = join(scratch, "state");
  mkdirSync(workspaceRoot, { mode: 0o755 });
  mkdirSync(state, { mode: 0o700 });
  const config = {
    configVersion: 1 as const,
    workspaceRoot,
    databasePath: join(state, "context.sqlite"),
    allowUpdates: true,
    ...(scope === undefined ? {} : { scope }),
    sessions: { observeGit: scope === "repository" },
  };
  const configPath = join(state, "handoff.json");
  writeFileSync(configPath, JSON.stringify(config), { mode: 0o600 });
  let time = Date.parse("2026-11-04T10:00:00.000Z");
  const now = () => new Date(time);
  const services: HandoffService[] = [];
  t.after(() => {
    for (const service of services) service.close();
    rmSync(scratch, {
      recursive: true,
      force: true,
      maxRetries: 10,
      retryDelay: 100,
    });
  });
  const agent = join(workspaceRoot, ".agent");
  const document = join(agent, "handoff.md");
  return {
    scratch,
    workspaceRoot,
    config,
    configPath,
    agent,
    document,
    advance: (seconds: number) => {
      time += seconds * 1000;
    },
    service: (
      overrides: Record<string, unknown> = {},
      options: { cwd?: string } = {},
    ) => {
      const value = createHandoffService(
        { ...config, ...overrides },
        { now, deferProjection: false, ...options },
      );
      services.push(value);
      return value;
    },
    write: (text: string | Buffer) => {
      mkdirSync(agent, { mode: 0o700, recursive: true });
      writeFileSync(document, text, { mode: 0o600 });
      return sha256(Buffer.from(text));
    },
    cli: (args: string[], stdin?: unknown) => {
      let stdout = "";
      let stderr = "";
      const code = runHandoffCli(args, {
        stdout: (text) => {
          stdout += text;
        },
        stderr: (text) => {
          stderr += text;
        },
        now,
        stdin: () => Buffer.from(JSON.stringify(stdin)),
      });
      return { code, stdout, stderr };
    },
  };
}

function update(expectedRevision: number, digest: string | null) {
  return {
    handoffVersion: 1,
    updateId: randomUUID(),
    expectedRevision,
    expectedDocumentDigest: digest,
    context: {
      activeAgent: "claude-code",
      goal: "Ship the adoption slice.",
      completed: ["Wrote the proposal."],
      touchedFiles: ["src/handoff.ts"],
      blockers: [],
      nextSteps: ["Review it."],
    },
    actionIds: [],
  };
}

const adopt = (expectedRevision: number, digest: string) => ({
  handoffVersion: 1,
  updateId: randomUUID(),
  expectedRevision,
  expectedDocumentDigest: digest,
});

const PLAIN = `# Agent Handoff & Session State

- **Last Active Agent**: Claude on the laptop
- **Last Updated**: 2026-11-04
- **Status**: Blocked on review
- **Status**: An older status

## 1. Active Goal / Task

Finish the import.

Keep the history.

## 2. Where We Left Off

- Wrote the parser
  continued on an indented line
- Added tests

## 3. Implementation Problems & Blockers

- CI fails on Windows

## 4. Immediate Next Steps

1. Fix the test
2. Open the PR
`;

test("the shared headings become a context, whatever their numbering", () => {
  const { context, recognized, omittedItems } = extractDocument(
    Buffer.from(PLAIN),
  );
  assert.equal(recognized, true);
  assert.equal(omittedItems, 0);
  assert.deepEqual(context, {
    activeAgent: "Claude-on-the-laptop",
    goal: "Status: Blocked on review\nFinish the import.\nKeep the history.",
    completed: ["Wrote the parser", "Added tests"],
    touchedFiles: [],
    blockers: ["CI fails on Windows"],
    nextSteps: ["Fix the test", "Open the PR"],
  });
  const loose = extractDocument(
    Buffer.from(
      "﻿# Plan\r\n\r\n## **Goal** ##\r\nShip it\r\n\r\n### Next steps\r\n* one\r\n",
    ),
  );
  assert.equal(loose.context.goal, "Ship it");
  assert.deepEqual(loose.context.nextSteps, ["one"]);
  assert.equal(loose.context.activeAgent, "unknown");
});

test("a ReproGate projection edited by hand reads back as it was written", () => {
  const record: HandoffRecordV1 = {
    handoffVersion: 1,
    workspaceId: `sha256:${"a".repeat(64)}`,
    revision: 1,
    updateId: randomUUID(),
    createdAt: "2026-11-04T10:00:00.000Z",
    provenance: "caller_asserted",
    expectedDocumentDigest: null,
    requestDigest: `sha256:${"b".repeat(64)}`,
    context: {
      activeAgent: "codex",
      goal: "Escape `this` and *that* #1",
      completed: [],
      touchedFiles: ["src/a.ts"],
      blockers: ["1. a [link](x)"],
      nextSteps: [],
    },
    references: [],
  };
  const { context } = extractDocument(renderHandoffRecord(record));
  assert.equal(context.activeAgent, "codex");
  assert.equal(context.goal, record.context.goal);
  assert.deepEqual(context.blockers, record.context.blockers);
  // Placeholders and sublists are not content.
  assert.deepEqual(context.completed, []);
  assert.deepEqual(context.nextSteps, []);
});

test("fenced text, unknown sections and deeper headings stay out of the context", () => {
  const { context } = extractDocument(
    Buffer.from(`## Goal
Real goal
\`\`\`
## Next steps
- fenced, not a step
\`\`\`
### A detail under the goal
More goal

## Landing log
- not a list we know

## Next steps
- real step
`),
  );
  assert.equal(context.goal, "Real goal\nMore goal");
  assert.deepEqual(context.nextSteps, ["real step"]);
  assert.deepEqual(context.completed, []);
});

test("a document with no known section adopts with a pointer to itself", () => {
  for (const text of ["", "just some prose\n", "\0\u0001binary\n"]) {
    const extracted = extractDocument(Buffer.from(text));
    assert.equal(extracted.recognized, false);
    assert.equal(extracted.context.goal, NO_GOAL_FOUND);
    assert.equal(extracted.context.activeAgent, "unknown");
  }
});

test("credentials are redacted across lines and control characters never reach the context", () => {
  const key = [
    "-----BEGIN PRIVATE KEY-----",
    "c2VjcmV0LWJvZHktbGluZS1vbmU=",
    "c2VjcmV0LWJvZHktbGluZS10d28=",
    "-----END PRIVATE KEY-----",
  ].join("\n");
  const token = `ghp_${"a".repeat(36)}`;
  const extracted = extractDocument(
    Buffer.from(
      `## Blockers\n${key}\n- token ${token}\n- escape \u001b[2J and ‮override\n`,
    ),
  );
  const stored = JSON.stringify(extracted.context);
  assert.equal(extracted.redactions, 2);
  assert.doesNotMatch(stored, /c2VjcmV0|ghp_/u);
  assert.doesNotMatch(
    extracted.context.blockers.join("\n"),
    // eslint-disable-next-line no-control-regex -- The point of the test.
    /[\u001b‮]/u,
  );
});

test("credentials hidden by Markdown escaping are redacted", () => {
  const github = `ghp_${"a".repeat(36)}`;
  const stripe = `sk_live_${"b".repeat(24)}`;
  const record: HandoffRecordV1 = {
    handoffVersion: 1,
    workspaceId: `sha256:${"a".repeat(64)}`,
    revision: 1,
    updateId: randomUUID(),
    createdAt: "2026-11-04T10:00:00.000Z",
    provenance: "caller_asserted",
    expectedDocumentDigest: null,
    requestDigest: `sha256:${"b".repeat(64)}`,
    context: {
      activeAgent: "codex",
      goal: `use ${github}`,
      completed: [`key ${stripe}`],
      touchedFiles: [],
      blockers: [],
      nextSteps: [],
    },
    references: [],
  };
  const rendered = renderHandoffRecord(record);
  assert.match(rendered.toString(), /ghp\\_/u);
  const extracted = extractDocument(rendered);
  assert.equal(extracted.redactions, 2);
  assert.doesNotMatch(JSON.stringify(extracted.context), /ghp_|sk_live_/u);
  const status = extractDocument(
    Buffer.from(
      `- **Last Active Agent**: ghp\\_${"a".repeat(36)}\n- **Status**: ${stripe.replaceAll("_", "\\_")}\n`,
    ),
  );
  assert.equal(status.context.activeAgent, "unknown");
  assert.doesNotMatch(JSON.stringify(status.context), /aaaa|bbbb/u);
});

test("only real code fences hide text", () => {
  const steps = (document: string) =>
    extractDocument(Buffer.from(document)).context.nextSteps;
  const after = "## Next steps\n- kept\n";
  // Backticks in the info string make this inline code, not a fence.
  assert.deepEqual(steps(`## Goal\n\`\`\`npm test\`\`\`\n${after}`), ["kept"]);
  // A fence that never closes hides nothing.
  assert.deepEqual(steps(`## Goal\n\`\`\`sh\n${after}`), ["kept"]);
  // A different marker or a shorter run does not close a fence.
  assert.deepEqual(steps("## Next steps\n```\n- no\n~~~\n- no\n```\n- yes\n"), [
    "yes",
  ]);
  assert.deepEqual(
    steps("## Next steps\n````\n- no\n```\n- no\n````\n- yes\n"),
    ["yes"],
  );
  // Text after a run of backticks does not close it either.
  assert.deepEqual(
    steps("## Next steps\n```\n- no\n``` x\n- no\n```\n- yes\n"),
    ["yes"],
  );
  const started = Date.now();
  extractDocument(Buffer.from("```a\n".repeat(200_000)));
  assert.ok(Date.now() - started < 2000);
});

test("hostile lines stay fast and the list caps hold", () => {
  const started = Date.now();
  extractDocument(
    Buffer.from(`# a${" ".repeat(MAX_ADOPTED_DOCUMENT_BYTES - 16)}x\n`),
  );
  extractDocument(Buffer.from(`${"#".repeat(7)} ${"# ".repeat(400_000)}x\n`));
  assert.ok(Date.now() - started < 2000);
  const many = extractDocument(
    Buffer.from(
      `## Next steps\n${Array.from({ length: 40 }, (_, i) => `- ${"x".repeat(2000)}${String(i)}`).join("\n")}\n`,
    ),
  );
  assert.equal(many.context.nextSteps.length, 16);
  assert.equal(many.omittedItems, 24);
  assert.ok(many.context.nextSteps.every((s) => Buffer.byteLength(s) <= 512));
});

test("adopting a drifted document changes no file and later updates archive it", (t) => {
  const f = fixture(t);
  const service = f.service();
  const first = service.update(update(0, null));
  const hand = `${readFileSync(f.document, "utf8")}\nA note added by hand.\n`;
  const digest = f.write(hand);
  const drifted = service.status(statusInput);
  assert.equal(drifted.state, "drifted");
  assert.equal(drifted.documentDigest, digest);

  const adopted = service.adopt(adopt(first.revision, digest));
  assert.equal(adopted.state, "synchronized");
  assert.equal(adopted.revision, 2);
  assert.equal(adopted.provenance, "adopted_document");
  assert.equal(adopted.projectedDigest, digest);
  assert.equal(readFileSync(f.document, "utf8"), hand);
  assert.equal(existsSync(join(f.agent, "handoff-history")), false);

  // The revision survives a new connection, whose integrity checks rerun.
  const reopened = f.service().status({ ...statusInput, includeContext: true });
  assert.equal(reopened.state, "synchronized");
  assert.equal(reopened.context?.goal, "Ship the adoption slice.");

  const next = service.update(update(2, digest));
  assert.equal(next.state, "synchronized");
  assert.equal(next.provenance, "caller_asserted");
  const archives = readdirSync(join(f.agent, "handoff-history"));
  assert.equal(archives.length, 1);
  assert.equal(
    readFileSync(join(f.agent, "handoff-history", archives[0] ?? ""), "utf8"),
    hand,
  );
});

test("an existing file-based handoff is imported once, as revision 1", (t) => {
  const f = fixture(t);
  const digest = f.write(PLAIN);
  const service = f.service();
  const before = service.status({ ...statusInput, brief: true });
  assert.equal(before.state, "missing");
  assert.equal(before.documentDigest, digest);
  assert.equal(before.brief?.handoff.document, "untracked");
  assert.match(service.briefText(), /exists but was never recorded/u);

  const imported = service.adopt(adopt(0, digest));
  assert.equal(imported.state, "synchronized");
  assert.equal(imported.revision, 1);
  const brief = service.brief();
  assert.equal(brief.handoff.document, "synchronized");
  assert.match(brief.handoff.goal ?? "", /^Status: Blocked on review\n/u);
  assert.deepEqual(brief.handoff.nextSteps, ["Fix the test", "Open the PR"]);
  assert.equal(brief.provenance.handoff, "adopted_document");
  assert.match(service.briefText(), /adopted from a document, revision 1/u);
  assert.doesNotMatch(service.briefText(), /never recorded/u);
  assert.throws(
    () => service.adopt(adopt(1, digest)),
    errorCode("not_drifted"),
  );
});

test("adoption binds the digest it was given and the revision it read", (t) => {
  const f = fixture(t);
  const service = f.service();
  const first = service.update(update(0, null));
  const synchronized = first.documentDigest ?? "";
  assert.throws(
    () => service.adopt(adopt(1, synchronized)),
    errorCode("not_drifted"),
  );
  const reviewed = f.write("reviewed\n");
  // A later edit was not what was reviewed.
  const later = f.write("edited after review\n");
  assert.throws(
    () => service.adopt(adopt(1, reviewed)),
    errorCode("document_conflict"),
  );
  assert.throws(
    () => service.adopt(adopt(0, later)),
    errorCode("revision_conflict"),
  );
  assert.equal(service.status(statusInput).revision, 1);
  assert.equal(service.status(statusInput).state, "drifted");
  assert.equal(service.adopt(adopt(1, later)).revision, 2);
});

test("a projection still in flight is never discarded by adoption", (t) => {
  const f = fixture(t);
  const base = f.write("base\n");
  const service = f.service();
  service.adopt(adopt(0, base));
  // A crash between reserving and projecting leaves revision 2 pending.
  const db = new DatabaseSync(f.config.databasePath, { readOnly: true });
  const workspaceId = String(
    db.prepare("SELECT workspace_id FROM handoff_snapshots").get()
      ?.workspace_id,
  );
  db.close();
  service.store.reserveHandoff(workspaceId, update(1, base), () => base);
  assert.equal(service.status(statusInput).state, "pending");
  assert.throws(() => service.adopt(adopt(2, base)), errorCode("not_drifted"));
  // A document that moved on is a real drift, and can be adopted.
  const moved = f.write("moved on\n");
  assert.equal(service.status(statusInput).state, "drifted");
  assert.equal(service.adopt(adopt(2, moved)).revision, 3);
});

test("an adoption retries idempotently and never reuses another request's ID", (t) => {
  const f = fixture(t);
  const digest = f.write(PLAIN);
  const service = f.service();
  const input = adopt(0, digest);
  assert.equal(service.adopt(input).revision, 1);
  assert.equal(service.adopt(input).revision, 1);
  assert.throws(
    () => service.adopt({ ...input, agent: "someone" }),
    errorCode("update_conflict"),
  );
  assert.throws(
    () =>
      service.update({
        ...update(1, digest),
        updateId: input.updateId,
      }),
    errorCode("update_conflict"),
  );
  // A retry after the state moved on does not rewind it.
  service.update(update(1, digest));
  assert.throws(() => service.adopt(input), errorCode("revision_conflict"));
});

test("read-only configurations cannot adopt, and agent labels are checked", async (t) => {
  const f = fixture(t);
  const digest = f.write(PLAIN);
  const service = f.service();
  assert.throws(
    () =>
      service.adopt({
        ...adopt(0, digest),
        agent: `ghp_${"a".repeat(36)}`,
      }),
    errorCode("invalid_input"),
  );
  assert.equal(service.adopt({ ...adopt(0, digest), agent: "me" }).revision, 1);
  assert.equal(
    service.status({ ...statusInput, includeContext: true }).context
      ?.activeAgent,
    "me",
  );
  const readOnly = f.service({ allowUpdates: false });
  assert.throws(() => readOnly.adopt(adopt(1, digest)), errorCode("read_only"));
  const server = createReproGateServer(undefined, undefined, readOnly);
  const client = new Client({ name: "read-only", version: "1.0.0" });
  const [a, b] = InMemoryTransport.createLinkedPair();
  t.after(async () => {
    await client.close();
    await server.close();
  });
  await server.connect(b);
  await client.connect(a);
  const { tools } = await client.listTools();
  assert.equal(
    tools.some((tool) => tool.name === "handoff_adopt"),
    false,
  );
});

test("MCP clients adopt through the tool and are told when to", async (t) => {
  const f = fixture(t);
  const digest = f.write(PLAIN);
  const service = f.service();
  const server = createReproGateServer(undefined, undefined, service);
  const client = new Client({ name: "adopter", version: "1.0.0" });
  const [a, b] = InMemoryTransport.createLinkedPair();
  t.after(async () => {
    await client.close();
    await server.close();
  });
  await server.connect(b);
  await client.connect(a);
  assert.match(client.getInstructions() ?? "", /handoff_adopt/u);
  const result = await client.callTool({
    name: "handoff_adopt",
    arguments: adopt(0, digest),
  });
  assert.equal(result.isError, undefined);
  assert.equal(
    (result.structuredContent as { state?: string }).state,
    "synchronized",
  );
  const stale = await client.callTool({
    name: "handoff_adopt",
    arguments: adopt(0, digest),
  });
  assert.equal(stale.isError, true);
});

test("the largest context a document can yield fits a snapshot", (t) => {
  const f = fixture(t);
  const item = `- ${'"'.repeat(600)}`;
  const list = Array.from({ length: 16 }, () => item).join("\n");
  const digest = f.write(
    `## Goal\n${'"'.repeat(4000)}\n## Completed\n${list}\n## Blockers\n${list}\n## Next steps\n${list}\n`,
  );
  assert.equal(f.service().adopt(adopt(0, digest)).revision, 1);
});

test("documents past the rendering limit adopt and archive; past the read limit they do not", (t) => {
  const f = fixture(t);
  const large = `## Goal\nLarge\n\n${"x".repeat(200 * 1024)}\n`;
  const digest = f.write(large);
  const service = f.service();
  assert.equal(service.adopt(adopt(0, digest)).state, "synchronized");
  assert.equal(service.update(update(1, digest)).state, "synchronized");
  const archives = readdirSync(join(f.agent, "handoff-history"));
  assert.equal(
    readFileSync(join(f.agent, "handoff-history", archives[0] ?? ""), "utf8"),
    large,
  );
  f.write("x".repeat(MAX_ADOPTED_DOCUMENT_BYTES + 1));
  assert.equal(service.status(statusInput).state, "unavailable");
});

test("a brief and the sessions file say when the document moved", (t) => {
  const f = fixture(t);
  const service = f.service();
  service.update(update(0, null));
  assert.equal(service.brief().handoff.document, "synchronized");
  f.write("edited\n");
  assert.equal(service.brief().handoff.document, "drifted");
  assert.match(service.briefText(), /changed outside ReproGate/u);
  service.join({ handoffVersion: 1, agent: "reader" });
  assert.match(
    readFileSync(join(f.agent, "sessions.md"), "utf8"),
    /changed outside ReproGate/u,
  );
  rmSync(f.document);
  assert.equal(service.brief().handoff.document, "deleted");
  assert.match(service.briefText(), /was deleted/u);
  // Deletion recovers without adoption: the next update writes the file.
  assert.equal(service.update(update(1, null)).state, "synchronized");
});

test(
  "a readable document in a private directory reads as drifted, not unavailable",
  posix,
  (t) => {
    const f = fixture(t);
    const service = f.service();
    service.update(update(0, null));
    // A sync or an editor that replaces the file resets its mode.
    rmSync(f.document);
    writeFileSync(f.document, "synced\n");
    chmodSync(f.document, 0o644);
    const status = service.status(statusInput);
    assert.equal(status.state, "drifted");
    assert.equal(
      service.adopt(adopt(1, status.documentDigest ?? "")).state,
      "synchronized",
    );
    // Nothing repaired it; the next projection replaces it privately.
    assert.equal(statSync(f.document).mode & 0o777, 0o644);
    service.update(update(2, status.documentDigest));
    assert.equal(statSync(f.document).mode & 0o777, 0o600);
  },
);

test(
  "a plain workspace is refused with a way forward, repaired on request and imported",
  posix,
  (t) => {
    const f = fixture(t);
    mkdirSync(f.agent);
    chmodSync(f.agent, 0o755);
    writeFileSync(f.document, PLAIN);
    chmodSync(f.document, 0o644);
    const other = join(f.agent, "notes.txt");
    writeFileSync(other, "not ours");
    chmodSync(other, 0o644);

    const refused = f.cli(["brief", "--config", f.configPath]);
    assert.equal(refused.code, 1);
    assert.match(refused.stderr, /not private: \.agent;/u);
    assert.match(refused.stderr, /--repair-permissions/u);
    const hook = f.cli(["hook", "--config", f.configPath], {
      cwd: f.workspaceRoot,
      hook_event_name: "SessionStart",
      session_id: "s1",
    });
    assert.equal(hook.code, 1);
    assert.match(hook.stderr, /--repair-permissions/u);
    assert.equal(statSync(f.agent).mode & 0o777, 0o755);

    const shown = f.cli([
      "adopt",
      "--config",
      f.configPath,
      "--repair-permissions",
    ]);
    assert.equal(shown.code, 0, shown.stderr);
    assert.match(shown.stdout, /Made private: \.agent\n/u);
    assert.match(shown.stdout, /Made private: \.agent\/handoff\.md\n/u);
    assert.match(shown.stdout, /State: missing at revision 0/u);
    assert.match(
      shown.stdout,
      /Goal: Status: Blocked on review\nFinish the import\./u,
    );
    assert.match(shown.stdout, /Completed: 2, blockers: 1, next steps: 2/u);
    assert.equal(statSync(f.agent).mode & 0o777, 0o700);
    assert.equal(statSync(f.document).mode & 0o777, 0o600);
    // Only the handoff's own files change.
    assert.equal(statSync(other).mode & 0o777, 0o644);
    // Showing recorded nothing.
    assert.equal(f.service().status(statusInput).revision, 0);

    const digest = /--digest (sha256:[0-9a-f]{64})/u.exec(shown.stdout)?.[1];
    assert.equal(digest, sha256(Buffer.from(PLAIN)));
    const done = f.cli([
      "adopt",
      "--config",
      f.configPath,
      "--digest",
      digest,
      "--agent",
      "person",
    ]);
    assert.equal(done.code, 0, done.stderr);
    assert.match(done.stdout, /revision 1/u);
    assert.equal(
      f.cli(["adopt", "--config", f.configPath, "--digest", digest]).code,
      1,
    );
    assert.equal(f.cli(["brief", "--config", f.configPath]).code, 0);
    assert.equal(f.cli(["adopt", "--config"]).code, 1);
  },
);

test("repair refuses links and never follows them", posix, (t) => {
  const outside = (f: ReturnType<typeof fixture>) => {
    const target = join(f.scratch, "target");
    writeFileSync(target, "keep");
    chmodSync(target, 0o644);
    return target;
  };
  const repair = (f: ReturnType<typeof fixture>) =>
    f.cli(["adopt", "--config", f.configPath, "--repair-permissions"]);

  const linkedDirectory = fixture(t);
  const realDirectory = join(linkedDirectory.scratch, "real-agent");
  mkdirSync(realDirectory);
  chmodSync(realDirectory, 0o755);
  symlinkSync(realDirectory, linkedDirectory.agent);
  assert.equal(repair(linkedDirectory).code, 1);
  assert.equal(statSync(realDirectory).mode & 0o777, 0o755);

  const linkedFile = fixture(t);
  const symlinkTarget = outside(linkedFile);
  mkdirSync(linkedFile.agent, { mode: 0o700 });
  symlinkSync(symlinkTarget, linkedFile.document);
  assert.equal(repair(linkedFile).code, 1);
  assert.equal(statSync(symlinkTarget).mode & 0o777, 0o644);

  const hardLinked = fixture(t);
  const hardTarget = outside(hardLinked);
  mkdirSync(hardLinked.agent, { mode: 0o700 });
  linkSync(hardTarget, hardLinked.document);
  assert.equal(repair(hardLinked).code, 1);
  assert.equal(statSync(hardTarget).mode & 0o777, 0o644);
});

function repository(f: ReturnType<typeof fixture>) {
  const root = f.workspaceRoot;
  git(root, "init", "-q", "-b", "main");
  writeFileSync(join(root, "a.txt"), "one\n");
  git(root, "add", "a.txt");
  git(root, "commit", "-q", "-m", "first");
  const linked = join(f.scratch, "linked");
  git(root, "worktree", "add", "-q", "-b", "topic", linked);
  return { root, linked };
}

test("repository scope shares one ledger across worktrees and reads each one's Git state", (t) => {
  const f = fixture(t, "repository");
  const { root, linked } = repository(f);
  const main = f.service();
  const other = f.service({}, { cwd: linked });

  const joined = main.join({ handoffVersion: 1, agent: "main-agent" });
  const remote = other.join({ handoffVersion: 1, agent: "linked-agent" });
  // Each sees the other's session, and where it ran.
  const names = new Map(
    remote.brief.sessions.map((s) => [s.agent, s.worktree]),
  );
  assert.equal(names.get("main-agent"), "workspace");
  assert.equal(remote.brief.git.branch, "topic");
  assert.equal(remote.brief.git.worktree, "linked");
  assert.equal(joined.brief.git.branch, "main");
  assert.match(other.briefText(), /Git \(observed now in linked\)/u);
  assert.match(other.briefText(), /worktree: workspace/u);

  // One handoff document, wherever the update came from.
  other.update(update(0, null));
  assert.equal(main.status(statusInput).revision, 1);
  assert.equal(existsSync(join(root, ".agent", "handoff.md")), true);
  assert.equal(existsSync(join(linked, ".agent")), false);
});

test("commits since a session count only that session's worktree", (t) => {
  const f = fixture(t, "repository");
  const { root, linked } = repository(f);
  const main = f.service();
  const other = f.service({}, { cwd: linked });
  main.join({ handoffVersion: 1, agent: "main-agent" });
  other.join({ handoffVersion: 1, agent: "linked-agent" });
  writeFileSync(join(linked, "b.txt"), "topic\n");
  git(linked, "add", "b.txt");
  git(linked, "commit", "-q", "-m", "topic work");
  const brief = other.join({ handoffVersion: 1, agent: "next" }).brief;
  assert.equal(brief.git.commitsSince?.count, 1);
  assert.match(brief.git.commitsSince.subjects[0] ?? "", /topic work/u);
  // The other worktree has no such commits, and no base from this one.
  const home = main.join({ handoffVersion: 1, agent: "home" }).brief;
  assert.equal(home.git.commitsSince, null);
  assert.equal(git(root, "rev-parse", "--abbrev-ref", "HEAD").trim(), "main");
});

test("hooks from any worktree of the repository are recorded under it; others are not", (t) => {
  const f = fixture(t, "repository");
  const { linked } = repository(f);
  const stranger = join(f.scratch, "stranger");
  mkdirSync(stranger);
  git(stranger, "init", "-q", "-b", "main");

  const started = f.cli(["hook", "--config", f.configPath], {
    cwd: linked,
    hook_event_name: "SessionStart",
    session_id: "linked-session",
  });
  assert.equal(started.code, 0, started.stderr);
  const context = (
    JSON.parse(started.stdout) as {
      hookSpecificOutput: { additionalContext: string };
    }
  ).hookSpecificOutput.additionalContext;
  assert.match(context, /Branch topic/u);

  const ignored = f.cli(["hook", "--config", f.configPath], {
    cwd: stranger,
    hook_event_name: "SessionStart",
    session_id: "stranger-session",
  });
  assert.equal(ignored.code, 0);
  assert.equal(ignored.stdout, "");
  const sessions = f.service().brief().sessions;
  assert.deepEqual(
    sessions.map((s) => [s.client, s.worktree]),
    [["claude-code", "linked"]],
  );
});

test("workspace scope ignores other worktrees, and switching scope starts a new ledger", (t) => {
  const f = fixture(t, "repository");
  const { linked } = repository(f);
  const scoped = f.service();
  scoped.update(update(0, null));
  scoped.close();

  const plain = f.service({ scope: "workspace" });
  const before = plain.status({ ...statusInput, brief: true });
  assert.equal(before.revision, 0);
  // The file is still there, so it can be brought across.
  assert.equal(before.brief?.handoff.document, "untracked");
  assert.equal(
    plain.hook("claude-code", {
      cwd: linked,
      hook_event_name: "SessionStart",
      session_id: "x",
    }).recorded,
    false,
  );
  assert.equal(
    plain.join({ handoffVersion: 1, agent: "plain" }).brief.git.worktree,
    null,
  );
  assert.equal(plain.brief().sessions[0]?.worktree, null);
});

test("a brief in another worktree says where the document is", (t) => {
  const f = fixture(t, "repository");
  const { linked } = repository(f);
  f.write(PLAIN);
  const other = f.service({}, { cwd: linked });
  assert.match(
    other.briefText(),
    /\.agent\/handoff\.md in the workspace worktree exists/u,
  );
  const plain = fixture(t);
  plain.write(PLAIN);
  assert.match(plain.service().briefText(), /: \.agent\/handoff\.md exists/u);
});

test("a session resumed in another worktree takes that worktree's head", (t) => {
  const f = fixture(t, "repository");
  const { root, linked } = repository(f);
  writeFileSync(join(linked, "b.txt"), "topic\n");
  git(linked, "add", "b.txt");
  git(linked, "commit", "-q", "-m", "topic work");
  writeFileSync(join(root, "c.txt"), "main\n");
  git(root, "add", "c.txt");
  git(root, "commit", "-q", "-m", "main work");
  const hook = (cwd: string, event: string) => {
    const { code, stderr } = f.cli(["hook", "--config", f.configPath], {
      cwd,
      hook_event_name: event,
      session_id: "moved",
    });
    assert.equal(code, 0, stderr);
  };
  hook(linked, "SessionStart");
  hook(linked, "SessionEnd");
  hook(root, "SessionStart");
  const brief = f.service().join({ handoffVersion: 1, agent: "next" }).brief;
  assert.equal(brief.git.branch, "main");
  // The session now starts at main's head: nothing to report, and no range
  // across the two branches.
  assert.equal(brief.git.commitsSince, null);
});

test("a repository nested in a worktree is another repository", (t) => {
  const f = fixture(t, "repository");
  repository(f);
  const nested = join(f.workspaceRoot, "vendor");
  mkdirSync(nested);
  git(nested, "init", "-q", "-b", "main");
  const inside = join(f.workspaceRoot, "plain-directory");
  mkdirSync(inside);
  const hook = (cwd: string, id: string) =>
    f.cli(["hook", "--config", f.configPath], {
      cwd,
      hook_event_name: "SessionStart",
      session_id: id,
    });
  assert.equal(hook(nested, "nested").stdout, "");
  assert.notEqual(hook(inside, "inside").stdout, "");
  assert.equal(f.service().brief().sessions.length, 1);
  const service = f.service();
  assert.equal(
    service.hook("claude-code", {
      cwd: nested,
      hook_event_name: "SessionStart",
      session_id: "direct",
    }).recorded,
    false,
  );
});

test("default scope does not depend on the process directory", posix, (t) => {
  const f = fixture(t);
  const gone = join(f.scratch, "gone");
  mkdirSync(gone);
  const home = process.cwd();
  process.chdir(gone);
  try {
    rmSync(gone, { recursive: true });
    assert.equal(f.service().status(statusInput).state, "missing");
  } finally {
    process.chdir(home);
  }
});

test("repository scope outlives a removed working directory", posix, (t) => {
  const f = fixture(t, "repository");
  repository(f);
  const gone = join(f.scratch, "gone");
  mkdirSync(gone);
  const home = process.cwd();
  process.chdir(gone);
  try {
    rmSync(gone, { recursive: true });
    const { git: observed } = f
      .service()
      .join({ handoffVersion: 1, agent: "x" }).brief;
    assert.equal(observed.branch, "main");
  } finally {
    process.chdir(home);
  }
});

test(
  "a sessions file reset by a sync is replaced, not left stale",
  posix,
  (t) => {
    const f = fixture(t);
    const service = f.service();
    service.join({ handoffVersion: 1, agent: "first" });
    const file = join(f.agent, "sessions.md");
    chmodSync(file, 0o644);
    service.join({ handoffVersion: 1, agent: "second" });
    assert.equal(service.status(statusInput).sessionsFile, "written");
    assert.match(readFileSync(file, "utf8"), /second/u);
    assert.equal(statSync(file).mode & 0o777, 0o600);
    // Others still cannot be allowed to write it.
    chmodSync(file, 0o664);
    service.join({ handoffVersion: 1, agent: "third" });
    assert.equal(service.status(statusInput).sessionsFile, "unavailable");
  },
);

test(
  "repair ignores what the service ignores, and refuses before it changes anything",
  posix,
  (t) => {
    const stray = fixture(t);
    const history = join(stray.agent, "handoff-history");
    mkdirSync(join(history, "old"), { recursive: true });
    chmodSync(stray.agent, 0o755);
    chmodSync(history, 0o755);
    const repaired = stray.cli([
      "adopt",
      "--config",
      stray.configPath,
      "--repair-permissions",
    ]);
    assert.equal(repaired.code, 0, repaired.stderr);
    assert.equal(statSync(stray.agent).mode & 0o777, 0o700);

    const linked = fixture(t);
    mkdirSync(linked.agent);
    chmodSync(linked.agent, 0o755);
    const target = join(linked.scratch, "target");
    writeFileSync(target, "keep");
    linkSync(target, linked.document);
    assert.equal(
      linked.cli([
        "adopt",
        "--config",
        linked.configPath,
        "--repair-permissions",
      ]).code,
      1,
    );
    assert.equal(statSync(linked.agent).mode & 0o777, 0o755);
  },
);

test("permission issues list only what the service refuses", posix, (t) => {
  const f = fixture(t);
  f.write("text\n");
  chmodSync(f.document, 0o644);
  assert.deepEqual(handoffPermissionIssues(f.workspaceRoot), []);
  chmodSync(f.document, 0o664);
  assert.deepEqual(handoffPermissionIssues(f.workspaceRoot), [
    join(".agent", "handoff.md"),
  ]);
  chmodSync(f.document, 0o600);
  chmodSync(f.agent, 0o750);
  assert.deepEqual(handoffPermissionIssues(f.workspaceRoot), [".agent"]);
  chmodSync(f.agent, 0o700);
});

test("a brief warns when the document cannot be read", (t) => {
  const f = fixture(t);
  const service = f.service();
  service.update(update(0, null));
  f.write("x".repeat(MAX_ADOPTED_DOCUMENT_BYTES + 1));
  assert.equal(service.brief().handoff.document, "unavailable");
  assert.match(service.briefText(), /Attention: .*could not be read/u);
});

test("the preview names the agent that would be recorded", (t) => {
  const f = fixture(t);
  f.write(PLAIN);
  const { stdout } = f.cli([
    "adopt",
    "--config",
    f.configPath,
    "--agent",
    "person",
  ]);
  assert.match(stdout, /Agent: person/u);
});

test("repository scope fails closed outside a repository", (t) => {
  const f = fixture(t, "repository");
  assert.throws(() => f.service(), errorCode("unavailable"));
});

test("a database from before worktrees gains the column", (t) => {
  const f = fixture(t);
  const service = f.service();
  const { sessionId } = service.join({ handoffVersion: 1, agent: "old" });
  service.close();
  const db = new DatabaseSync(f.config.databasePath);
  db.exec("ALTER TABLE handoff_sessions DROP COLUMN worktree");
  db.close();
  const upgraded = f.service();
  assert.equal(
    upgraded.brief().sessions.find((s) => s.sessionId === sessionId)?.worktree,
    null,
  );
  upgraded.join({ handoffVersion: 1, agent: "new" });
});

test("adoption and scope match the published schemas", (t) => {
  const ajv = new Ajv2020({ strict: false, allowUnionTypes: true });
  for (const name of ["handoff", "handoff-config"])
    ajv.addSchema(
      JSON.parse(
        readFileSync(
          fileURLToPath(
            new URL(`../../schemas/${name}.schema.json`, import.meta.url),
          ),
          "utf8",
        ),
      ) as object,
    );
  const base = "https://github.com/adimalkar/mcp-repro-gate/schemas/";
  const check = (ref: string, value: unknown) => {
    const validate = ajv.getSchema(`${base}${ref}`);
    assert.ok(validate, ref);
    assert.equal(validate(value), true, JSON.stringify(validate.errors));
  };
  const f = fixture(t, "repository");
  repository(f);
  check("handoff-config.schema.json", f.config);
  const digest = f.write(PLAIN);
  const service = f.service();
  const input = adopt(0, digest);
  check("handoff.schema.json#/$defs/adopt", input);
  const status = service.adopt(input);
  check("handoff.schema.json#/$defs/status", status);
  const { sessionId } = service.join({ handoffVersion: 1, agent: "checked" });
  check(
    "handoff.schema.json#/$defs/status",
    service.status({ ...statusInput, brief: true, sessionId }),
  );
  const db = new DatabaseSync(f.config.databasePath, { readOnly: true });
  const row = db.prepare("SELECT snapshot_json FROM handoff_snapshots").get();
  db.close();
  check("handoff.schema.json", JSON.parse(String(row?.snapshot_json)));
});
