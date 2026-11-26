import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { generateKeyPairSync, randomUUID } from "node:crypto";
import { readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

import { gitOperatorKeyId } from "../src/git-operator-review.js";
import { releaseCandidateKeep } from "../src/git-promotion-keep.js";
import { prepareGitPromotionObjects } from "../src/git-promotion-objects.js";
import { evaluatePolicy } from "../src/policy.js";
import {
  candidateKeeps,
  firstOperator,
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
      git(f.root, "branch", "elsewhere", "HEAD");
      worktree(f, "elsewhere");
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
  [
    "fetch updates a remote-tracking branch",
    (f: Fixture) => {
      git(f.root, "update-ref", "refs/remotes/origin/main", "HEAD");
    },
  ],
  [
    "default garbage collection",
    (f: Fixture) => {
      git(f.root, "gc", "-q");
    },
  ],
  [
    "refs packed",
    (f: Fixture) => {
      git(f.root, "pack-refs", "--all");
    },
  ],
  [
    "local draft stashed",
    (f: Fixture) => {
      writeFileSync(join(f.root, "value.txt"), "local draft\n");
      git(f.root, "stash", "-q");
    },
  ],
  [
    "tracked file touched without a content change",
    (f: Fixture) => {
      utimesSync(join(f.root, "value.txt"), 1_000_000_000, 1_000_000_000);
    },
  ],
  [
    "local Git hook added",
    (f: Fixture) => {
      writeFileSync(
        join(f.root, ".git", "hooks", "pre-commit"),
        "#!/bin/sh\nexit 0\n",
        { mode: 0o755 },
      );
    },
  ],
  [
    "catalog tool description reworded",
    (f: Fixture) => {
      f.context.catalogTool.description = "reworded description";
    },
  ],
  [
    "second operator trusted",
    (f: Fixture) => {
      const { publicKey } = generateKeyPairSync("ed25519");
      f.trust.operators.push({
        operatorId: "bob",
        enabled: true,
        keys: [
          {
            keyId: gitOperatorKeyId(publicKey),
            publicKeyPem: publicKey
              .export({ type: "spki", format: "pem" })
              .toString(),
            enabled: true,
          },
        ],
        permissions: [{ ...firstOperator(f.trust).permission }],
      });
    },
  ],
] satisfies [string, (f: Fixture) => void][];

// Every change must be ignored, so they are applied together: if any one
// were refused, so would the whole set. A fixture each would add many minutes
// on Windows. To find the culprit of a failure, shorten the list.
function applyAll(f: Fixture) {
  for (const [, change] of preserving) change(f);
}

test("approval preserved: no change (control)", (t) => {
  const f = fixture(t);
  reserve(f);
  assertPromoted(f);
});

test(`approval preserved: ${String(preserving.length)} benign changes before reservation`, (t) => {
  const f = fixture(t);
  applyAll(f);
  reserve(f);
  assertPromoted(f);
});

test(`approval preserved: ${String(preserving.length)} benign changes between reservation and promotion`, (t) => {
  const f = fixture(t);
  reserve(f);
  applyAll(f);
  assertPromoted(f);
});

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
    "source worktree switched to a new branch",
    /workspace no longer matches the proposed intent/u,
    (f: Fixture) => {
      git(f.root, "switch", "-qC", "other");
      return () => {
        git(f.root, "switch", "-q", "source");
      };
    },
  ],
  [
    "agent commits more work on the source branch",
    /tree, or destination ref is inconsistent/u,
    (f: Fixture) => {
      writeFileSync(join(f.root, "more.txt"), "next step\n");
      git(f.root, "add", "more.txt");
      git(f.root, "commit", "-qm", "next step");
      return () => {
        // Keeps the new work on its own branch.
        git(f.root, "branch", "-f", "next-step");
        git(f.root, "reset", "-q", "--hard", "HEAD~1");
      };
    },
  ],
  [
    "a teammate's commit lands on the destination",
    /tree, or destination ref is inconsistent/u,
    (f: Fixture) => {
      const old = f.prepared.expectedOldOid;
      const tree = git(f.root, "rev-parse", "HEAD^{tree}").toString().trim();
      const blob = git(f.root, "rev-parse", "HEAD:value.txt").toString().trim();
      const theirs = execFileSync("git", ["-C", f.root, "mktree"], {
        input: `100644 blob ${blob}\tteammate.txt\n100644 blob ${blob}\tvalue.txt\n`,
      })
        .toString()
        .trim();
      assert.notEqual(theirs, tree);
      const next = git(
        f.root,
        "commit-tree",
        theirs,
        "-p",
        old,
        "-m",
        "teammate change",
      )
        .toString()
        .trim();
      git(f.root, "update-ref", f.context.destinationRef, next, old);
      return () => {
        // Only shows the approval was not spent; nobody should undo a
        // teammate's commit to reuse it.
        git(f.root, "update-ref", f.context.destinationRef, old, next);
      };
    },
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

// Nothing refers to the candidate until promotion. Only the keep file beside
// its pack stops these commands from deleting it.
test("approval preserved: unreachable objects pruned before and after reservation", (t) => {
  const f = fixture(t);
  const prune = () => {
    git(f.root, "gc", "-q", "--prune=now");
    git(f.root, "repack", "-q", "-a", "-d");
    git(f.root, "prune", "--expire=now");
  };
  const orphan = git(f.root, "commit-tree", "-m", "orphan", "HEAD^{tree}")
    .toString()
    .trim();
  assert.deepEqual(candidateKeeps(f), [f.prepared.attemptId]);
  prune();
  // Control: the commands really do delete what nothing keeps.
  assert.throws(() => git(f.root, "cat-file", "-e", orphan));
  reserve(f);
  prune();
  assert.deepEqual(candidateKeeps(f), [f.prepared.attemptId]);
  assertPromoted(f);
  assert.deepEqual(candidateKeeps(f), []);
  prune();
  assert.equal(git(f.root, "show", "target:value.txt").toString(), "after\n");
});

test("a candidate that is gone anyway is named, and its approval stays spent", (t) => {
  const f = fixture(t);
  const lose = (attemptId: string) => {
    releaseCandidateKeep(f.root, attemptId);
    git(f.root, "gc", "-q", "--prune=now");
  };
  reserve(f);
  lose(f.prepared.attemptId);
  const before = target(f);
  const missing = (oid: string) =>
    new RegExp(`Candidate commit ${oid} is missing from the repository`, "u");
  assert.throws(() => promote(f), missing(f.prepared.candidateCommitOid));
  assert.throws(() => promote(f), /precheck rejected: candidate_rejected \(/u);
  const status = f.store.getGitPromotionStatus(f.prepared.attemptId);
  assert.equal(status?.state, "prepared");
  assert.equal(status.admission, undefined);

  // A new candidate is a different commit, so the reserved one cannot be
  // rebuilt. Recovery ends the attempt and frees the fence, but the one-use
  // approval stays spent: it refuses a fresh candidate under a new fence.
  const recovered = f.store.recoverGitPromotionAttempt({
    attemptId: f.prepared.attemptId,
    hostControl: f.hostControl,
    acknowledgement: { childrenQuiescent: true },
  });
  assert.equal(recovered.status.state, "failed");
  assert.equal(recovered.fence, "released");
  const again = prepareGitPromotionObjects({
    proposal: f.proposal,
    repositoryPath: f.root,
    patch: f.patch,
    attemptId: randomUUID(),
  });
  assert.notEqual(again.candidateCommitOid, f.prepared.candidateCommitOid);
  const owner = f.control.acquire(again.attemptId);
  assert.throws(
    () => reserve(f, { prepared: again, owner }),
    /permanently consumed/u,
  );
  lose(again.attemptId);
  assert.throws(
    () => reserve(f, { prepared: again, owner }),
    missing(again.candidateCommitOid),
  );
  assert.equal(target(f), before);
});
