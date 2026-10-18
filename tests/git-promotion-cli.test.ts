import { Ajv2020 } from "ajv/dist/2020.js";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { fileURLToPath } from "node:url";
import { runGitReviewCli } from "../src/git-review-cli.js";
import {
  loadGitReviewConfigSnapshot,
  parseGitReviewConfig,
} from "../src/git-review-config.js";
import { fixture, git, reserve } from "./helpers/git-promotion-journal.js";

// Keep cases sequential within this file; Node isolates each suite.

type Fixture = ReturnType<typeof fixture>;

function setup(t: TestContext, version: 1 | 2 = 2) {
  const f = fixture(t);
  const configPath = join(f.scratch, "review.json");
  const common = {
    repositoryPath: f.root,
    repositoryId: f.context.repositoryId,
    destinationRef: f.context.destinationRef,
    planDatabasePath: join(f.scratch, "plans.sqlite"),
    approvalDatabasePath: f.databasePath,
    catalogTool: f.context.catalogTool,
    currentPolicy: f.context.currentPolicy,
    trust: f.trust,
  };
  const config =
    version === 2
      ? {
          configVersion: 2,
          ...common,
          destinationMode: "uncheckout_destination",
          ownership: {
            kind: "persistent_directory",
            fencePath: f.hostControl.fencePath,
          },
        }
      : { configVersion: 1, ...common };
  writeFileSync(configPath, JSON.stringify(config), { mode: 0o600 });
  const proposalPath = join(f.scratch, "proposal.json");
  writeFileSync(proposalPath, JSON.stringify(f.proposal), { mode: 0o600 });
  const patchPath = join(f.scratch, "change.patch");
  writeFileSync(patchPath, f.patch, { mode: 0o600 });
  return { f, config, configPath, proposalPath, patchPath };
}
function cli(args: string[]) {
  let stdout = "";
  let stderr = "";
  const code = runGitReviewCli(args, {
    stdout: (text) => {
      stdout += text;
    },
    stderr: (text) => {
      stderr += text;
    },
  });
  return { code, stdout, stderr };
}
function json(output: string): Record<string, unknown> {
  return JSON.parse(output) as Record<string, unknown>;
}
function promoteArgs(s: ReturnType<typeof setup>) {
  return [
    "promote",
    "--config",
    s.configPath,
    "--proposal",
    s.proposalPath,
    "--patch",
    s.patchPath,
    "--approval-id",
    s.f.approval.approvalId,
  ];
}
function attemptArgs(
  command: string,
  s: ReturnType<typeof setup>,
  attemptId: string,
) {
  return [command, "--config", s.configPath, "--attempt-id", attemptId];
}
function target(f: Fixture): string {
  return git(f.root, "rev-parse", "refs/heads/target").toString().trim();
}
// The CLI acquires its own fence for a fresh attempt.
function releaseFixtureFence(f: Fixture) {
  f.control.release(f.owner, { childrenQuiescent: true });
}

test("promote confirms, status reads it back, and a second promote releases its fence", (t) => {
  const s = setup(t);
  releaseFixtureFence(s.f);
  const first = cli(promoteArgs(s));
  assert.equal(first.code, 0, first.stderr);
  const summary = json(first.stdout);
  assert.equal(summary.state, "confirmed");
  assert.equal(summary.reason, "ref_updated");
  assert.equal(summary.fence, "released");
  assert.equal(target(s.f), summary.candidateCommitOid);
  assert.equal(
    git(s.f.root, "symbolic-ref", "HEAD").toString(),
    "refs/heads/source\n",
  );
  const status = cli(attemptArgs("status", s, summary.attemptId as string));
  assert.equal(status.code, 0, status.stderr);
  assert.equal(json(status.stdout).state, "confirmed");
  // The approval is consumed: reservation fails, nothing was reserved, and
  // the fresh attempt's fence is released again.
  const second = cli(promoteArgs(s));
  assert.equal(second.code, 1);
  assert.match(second.stderr, /stopped \(fence released\)/u);
  assert.equal(second.stdout, "");
  assert.equal(s.f.control.query().status, "available");
});

test("a version 1 config cannot promote or read promotion status", (t) => {
  const s = setup(t, 1);
  releaseFixtureFence(s.f);
  const promoted = cli(promoteArgs(s));
  assert.equal(promoted.code, 1);
  assert.match(promoted.stderr, /version 1 cannot promote/u);
  assert.equal(cli(attemptArgs("status", s, randomUUID())).code, 1);
  assert.equal(target(s.f), s.f.prepared.expectedOldOid);
  assert.equal(s.f.control.query().status, "available");
});

test("resume runs the gate for a prepared attempt under its own fence", (t) => {
  const s = setup(t);
  reserve(s.f);
  const resumed = cli(attemptArgs("resume", s, s.f.prepared.attemptId));
  assert.equal(resumed.code, 0, resumed.stderr);
  const summary = json(resumed.stdout);
  assert.equal(summary.attemptId, s.f.prepared.attemptId);
  assert.equal(summary.state, "confirmed");
  assert.equal(summary.fence, "released");
  assert.equal(target(s.f), s.f.prepared.candidateCommitOid);
  assert.equal(cli(attemptArgs("resume", s, s.f.prepared.attemptId)).code, 1);
});

test("recover fails a reserved, never-admitted attempt and releases its fence", (t) => {
  const s = setup(t);
  reserve(s.f);
  const recovered = cli([
    ...attemptArgs("recover", s, s.f.prepared.attemptId),
    "--confirm-quiescent",
  ]);
  assert.equal(recovered.code, 0, recovered.stderr);
  const summary = json(recovered.stdout);
  assert.equal(summary.state, "failed");
  assert.equal(summary.reason, "abandoned");
  assert.equal(summary.fence, "released");
  assert.equal(target(s.f), s.f.prepared.expectedOldOid);
});

test("recover releases a fence whose attempt was never reserved", (t) => {
  const s = setup(t);
  const recovered = cli([
    ...attemptArgs("recover", s, s.f.prepared.attemptId),
    "--confirm-quiescent",
  ]);
  assert.equal(recovered.code, 0, recovered.stderr);
  assert.deepEqual(json(recovered.stdout), {
    attemptId: s.f.prepared.attemptId,
    fence: "released",
    state: "unreserved",
  });
  assert.equal(s.f.control.query().status, "available");
  // Nothing is held any more for this or any other attempt.
  assert.equal(
    cli([
      ...attemptArgs("recover", s, s.f.prepared.attemptId),
      "--confirm-quiescent",
    ]).code,
    1,
  );
});

test("recover requires a valueless --confirm-quiescent exactly once", (t) => {
  const s = setup(t);
  const base = attemptArgs("recover", s, s.f.prepared.attemptId);
  for (const args of [
    base,
    [...base, "--confirm-quiescent", "yes"],
    [...base, "--confirm-quiescent", "--confirm-quiescent"],
    [...base, "--confirm-quiescent", "--unknown"],
    [...attemptArgs("recover", s, "not-a-uuid"), "--confirm-quiescent"],
  ]) {
    const result = cli(args);
    assert.equal(result.code, 2, args.join(" "));
  }
  assert.equal(s.f.control.query().status, "held");
});

test("status of an unknown attempt reports found false", (t) => {
  const s = setup(t);
  const result = cli(attemptArgs("status", s, randomUUID()));
  assert.equal(result.code, 1);
  assert.deepEqual(json(result.stdout), { found: false });
});

test("prepare emits a version 2 request under a version 2 config only", (t) => {
  const v2 = setup(t);
  const prepared = cli([
    "prepare",
    "--config",
    v2.configPath,
    "--proposal",
    v2.proposalPath,
    "--patch",
    v2.patchPath,
  ]);
  assert.equal(prepared.code, 0, prepared.stderr);
  assert.equal(json(prepared.stdout).requestVersion, 2);
  // A version 1 config refuses the version 2 proposal.
  const v1Path = join(v2.f.scratch, "review-v1.json");
  const v1Config: Record<string, unknown> = { ...v2.config, configVersion: 1 };
  delete v1Config.destinationMode;
  delete v1Config.ownership;
  writeFileSync(v1Path, JSON.stringify(v1Config), { mode: 0o600 });
  const refused = cli([
    "prepare",
    "--config",
    v1Path,
    "--proposal",
    v2.proposalPath,
    "--patch",
    v2.patchPath,
  ]);
  assert.equal(refused.code, 1);
  assert.match(refused.stderr, /not version 1 like the config/u);
});

test("version 2 configs require a separate, absolute fence outside the repository", (t) => {
  const s = setup(t);
  const variant = (ownership: unknown, extra: Record<string, unknown> = {}) => {
    const path = join(s.f.scratch, `variant-${randomUUID()}.json`);
    writeFileSync(path, JSON.stringify({ ...s.config, ownership, ...extra }), {
      mode: 0o600,
    });
    return path;
  };
  const kind = "persistent_directory";
  assert.equal(
    loadGitReviewConfigSnapshot(s.configPath).paths.fencePath,
    s.f.hostControl.fencePath,
  );
  for (const [path, message] of [
    [variant({ kind, fencePath: "fence" }), /absolute/u],
    [
      variant({ kind, fencePath: join(s.f.root, "fence") }),
      /outside the protected/u,
    ],
    [variant({ kind, fencePath: s.f.databasePath }), /separate from the plan/u],
    [
      variant({ kind, fencePath: `${s.f.databasePath}-wal` }),
      /separate from the plan/u,
    ],
    [
      variant({ kind: "other", fencePath: s.f.hostControl.fencePath }),
      /strict/u,
    ],
    [
      variant({ kind, fencePath: s.f.hostControl.fencePath, extra: true }),
      /strict/u,
    ],
    [
      variant(
        { kind, fencePath: s.f.hostControl.fencePath },
        { destinationMode: "checked_out" },
      ),
      /strict/u,
    ],
  ] as const)
    assert.throws(() => loadGitReviewConfigSnapshot(path), message);
  const missing = { ...s.config } as Record<string, unknown>;
  delete missing.destinationMode;
  assert.throws(() => parseGitReviewConfig(missing), /strict/u);
});

test("the version 2 config schema agrees with the strict loader", (t) => {
  const s = setup(t);
  const read = (name: string) =>
    JSON.parse(
      readFileSync(
        new URL(`../../schemas/${name}.schema.json`, import.meta.url),
        "utf8",
      ),
    ) as object;
  const validate = new Ajv2020({ strict: true })
    .addSchema(read("git-operator-review"))
    .addSchema(read("git-review-config-v2"))
    .getSchema("https://reprogate.dev/schemas/git-review-config-v2.json");
  assert.ok(validate);
  const config = JSON.parse(JSON.stringify(s.config)) as Record<
    string,
    unknown
  >;
  assert.equal(validate(config), true, JSON.stringify(validate.errors));
  assert.equal(parseGitReviewConfig(config).configVersion, 2);
  const without = (key: string) =>
    Object.fromEntries(Object.entries(config).filter(([name]) => name !== key));
  for (const value of [
    { ...config, extra: true },
    { ...config, configVersion: 1 },
    without("ownership"),
    without("destinationMode"),
    { ...config, ownership: { kind: "persistent_directory" } },
  ]) {
    assert.equal(validate(value), false);
    assert.throws(() => parseGitReviewConfig(value));
  }
});

test("the built reprogate binary promotes and reads status end to end", (t) => {
  const s = setup(t);
  releaseFixtureFence(s.f);
  const binary = fileURLToPath(new URL("../src/cli.js", import.meta.url));
  const run = (args: string[]) =>
    spawnSync(process.execPath, [binary, "git-review", ...args], {
      encoding: "utf8",
      timeout: 120_000,
    });
  const promoted = run(promoteArgs(s));
  assert.equal(promoted.status, 0, promoted.stderr);
  const summary = json(promoted.stdout);
  assert.equal(summary.state, "confirmed");
  // The CLI prepares its own candidate: its commit names a fresh attempt.
  assert.equal(target(s.f), summary.candidateCommitOid);
  assert.notEqual(summary.candidateCommitOid, s.f.prepared.candidateCommitOid);
  const status = run(attemptArgs("status", s, summary.attemptId as string));
  assert.equal(status.status, 0, status.stderr);
  assert.equal(json(status.stdout).state, "confirmed");
  assert.equal(run(attemptArgs("status", s, randomUUID())).status, 1);
});
