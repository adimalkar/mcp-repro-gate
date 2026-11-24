import assert from "node:assert/strict";
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

import { evaluatePolicy } from "../src/policy.js";
import {
  fixture,
  git,
  noAttempt,
  reserve,
} from "./helpers/git-promotion-journal.js";

type Fixture = ReturnType<typeof fixture>;
type Change = (f: Fixture) => () => void;

function target(f: Fixture) {
  return git(f.root, "rev-parse", f.context.destinationRef).toString().trim();
}

function worktree(f: Fixture, branch: string) {
  const path = join(f.scratch, "linked");
  git(f.root, "worktree", "add", "-q", path, branch);
  return () => {
    git(f.root, "worktree", "remove", path);
  };
}

function promote(f: Fixture) {
  return f.store.promoteGitPromotionAttempt({
    attemptId: f.prepared.attemptId,
    context: f.context,
    trust: f.trust,
    hostControl: f.hostControl,
    owner: f.owner,
  });
}

function assertPromoted(f: Fixture) {
  const file = join(f.root, "value.txt");
  const source = git(f.root, "rev-parse", "HEAD");
  const contents = readFileSync(file);
  const result = promote(f);
  assert.equal(result.status.state, "confirmed");
  assert.equal(result.status.attempt.approvalId, f.approval.approvalId);
  assert.equal(target(f), f.prepared.candidateCommitOid);
  assert.equal(git(f.root, "show", "target:value.txt").toString(), "after\n");
  assert.deepEqual(git(f.root, "rev-parse", "HEAD"), source);
  assert.deepEqual(readFileSync(file), contents);
}

const preserving = [
  ["no change (control)", null],
  [
    "unrelated branch moves",
    (f: Fixture) => {
      const commit = git(
        f.root,
        "commit-tree",
        "HEAD^{tree}",
        "-p",
        "HEAD",
        "-m",
        "other branch",
      )
        .toString()
        .trim();
      git(f.root, "branch", "other", "HEAD");
      git(f.root, "update-ref", "refs/heads/other", commit);
    },
  ],
  [
    "release tag added",
    (f: Fixture) => {
      git(f.root, "tag", "release-test", "HEAD");
    },
  ],
  [
    "unrelated linked worktree added",
    (f: Fixture) => {
      git(f.root, "branch", "other", "HEAD");
      worktree(f, "other");
    },
  ],
  [
    "ignored local runtime file added",
    (f: Fixture) => {
      const name = "runtime.local";
      writeFileSync(join(f.root, ".git", "info", "exclude"), `/${name}\n`);
      writeFileSync(join(f.root, name), "runtime data\n");
      assert.equal(git(f.root, "check-ignore", name).toString().trim(), name);
    },
  ],
  [
    "local author name updated",
    (f: Fixture) => {
      git(f.root, "config", "user.name", "New Author");
    },
  ],
] satisfies [string, ((f: Fixture) => void) | null][];

for (const [name, change] of preserving) {
  test(`approval preserved: ${name}`, (t) => {
    const f = fixture(t);
    change?.(f);
    reserve(f);
    assertPromoted(f);
  });
}

const gated = [
  [
    "tracked scratch edit",
    /worktree must be clean/u,
    (f: Fixture) => {
      const file = join(f.root, "value.txt");
      writeFileSync(file, "local draft\n");
      return () => {
        git(f.root, "restore", "value.txt");
      };
    },
  ],
  [
    "untracked scratch note",
    /worktree must be clean/u,
    (f: Fixture) => {
      const file = join(f.root, "notes.local");
      writeFileSync(file, "local draft\n");
      return () => {
        rmSync(file);
      };
    },
  ],
  [
    "destination checked out for inspection",
    /Destination branch is checked out/u,
    (f: Fixture) => worktree(f, "target"),
  ],
  [
    "both bound branches advance to the same tree",
    /workspace no longer matches the proposed intent/u,
    (f: Fixture) => {
      const old = f.prepared.expectedOldOid;
      const next = git(
        f.root,
        "commit-tree",
        "HEAD^{tree}",
        "-p",
        old,
        "-m",
        "empty maintenance commit",
      )
        .toString()
        .trim();
      assert.notEqual(next, old);
      git(f.root, "update-ref", "refs/heads/source", next, old);
      git(f.root, "update-ref", f.context.destinationRef, next, old);
      assert.equal(
        git(f.root, "rev-parse", "HEAD^{tree}").toString().trim(),
        f.proposal.workspace.headTree,
      );
      return () => {
        git(f.root, "update-ref", f.context.destinationRef, old, next);
        git(f.root, "update-ref", "refs/heads/source", old, next);
      };
    },
  ],
  [
    "policy adds a rule for a different tool",
    /its policy has changed/u,
    (f: Fixture) => {
      const policy = f.context.currentPolicy;
      const tool = f.context.catalogTool;
      const before = evaluatePolicy(policy, tool.toolRef, tool.effects);
      policy.rules.push({
        id: "unrelated-read-rule",
        match: { toolRef: "other.read", effect: "local_read" },
        priority: 10,
        decision: "deny",
        reason: "Disallow a separate read tool",
      });
      const after = evaluatePolicy(policy, tool.toolRef, tool.effects);
      assert.equal(after.decision, before.decision);
      assert.deepEqual(after.reasons, before.reasons);
      assert.notEqual(after.policyDigest, before.policyDigest);
      return () => {
        policy.rules.pop();
      };
    },
  ],
] satisfies [string, RegExp, Change][];

for (const [name, reason, change] of gated) {
  test(`approval blocked during benign drift: ${name}`, (t) => {
    const f = fixture(t);
    let restore = change(f);
    const beforeReservation = target(f);
    assert.throws(() => reserve(f), reason);
    noAttempt(f);
    assert.equal(target(f), beforeReservation);
    restore();

    reserve(f);
    restore = change(f);
    const beforePromotion = target(f);
    assert.throws(() => promote(f), /precheck rejected: authority_rejected/u);
    const status = f.store.getGitPromotionStatus(f.prepared.attemptId);
    assert.equal(status?.state, "prepared");
    assert.equal(status.admission, undefined);
    assert.equal(status.outcome, undefined);
    assert.equal(target(f), beforePromotion);
    restore();

    assertPromoted(f);
  });
}
