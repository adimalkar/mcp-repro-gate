import { Ajv2020 } from "ajv/dist/2020.js";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  sign,
  type KeyObject,
} from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";

import { digestCanonical, sha256 } from "../src/digest.js";
import {
  gitOperatorKeyId,
  gitOperatorReviewDigest,
  signGitOperatorReview,
  type GitOperatorReviewPayloadV1,
} from "../src/git-operator-review.js";
import {
  verifyGitPromotionEvidence,
  type GitPromotionEvidenceReport,
} from "../src/git-promotion-evidence.js";
import { runGitReviewCli } from "../src/git-review-cli.js";
import { fixture, git, reserve } from "./helpers/git-promotion-journal.js";

// Keep cases sequential within this file; Node isolates each suite.

type Json = Record<string, unknown>;

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

function keyPair() {
  const { privateKey } = generateKeyPairSync("ed25519");
  const publicKey = createPublicKey(privateKey);
  return {
    privateKey,
    keyId: gitOperatorKeyId(publicKey),
    publicKeyPem: publicKey.export({ type: "spki", format: "pem" }).toString(),
  };
}

function setup(t: TestContext, options: { evidence?: boolean } = {}) {
  const f = fixture(t);
  const host = keyPair();
  const keyPath = join(f.scratch, "evidence-key.pem");
  writeFileSync(
    keyPath,
    host.privateKey.export({ type: "pkcs8", format: "pem" }),
    { mode: 0o600 },
  );
  const config = {
    configVersion: 2,
    repositoryPath: f.root,
    repositoryId: f.context.repositoryId,
    destinationRef: f.context.destinationRef,
    planDatabasePath: join(f.scratch, "plans.sqlite"),
    approvalDatabasePath: f.databasePath,
    catalogTool: f.context.catalogTool,
    currentPolicy: f.context.currentPolicy,
    trust: f.trust,
    destinationMode: "uncheckout_destination",
    ownership: {
      kind: "persistent_directory",
      fencePath: f.hostControl.fencePath,
    },
    ...(options.evidence === false
      ? {}
      : { evidence: { signingKeyPath: keyPath } }),
  };
  const configPath = join(f.scratch, "review.json");
  writeFileSync(configPath, JSON.stringify(config), { mode: 0o600 });
  const proposalPath = join(f.scratch, "proposal.json");
  writeFileSync(proposalPath, JSON.stringify(f.proposal), { mode: 0o600 });
  const patchPath = join(f.scratch, "change.patch");
  writeFileSync(patchPath, f.patch, { mode: 0o600 });
  const trust = {
    evidenceTrustVersion: 1,
    hostKeys: [{ keyId: host.keyId, publicKeyPem: host.publicKeyPem }],
    review: f.trust,
  };
  const trustPath = join(f.scratch, "trust.json");
  writeFileSync(trustPath, JSON.stringify(trust));
  return {
    f,
    host,
    config,
    configPath,
    proposalPath,
    patchPath,
    trust,
    trustPath,
  };
}

type Setup = ReturnType<typeof setup>;

function promote(s: Setup): string {
  s.f.control.release(s.f.owner, { childrenQuiescent: true });
  const result = cli([
    "promote",
    "--config",
    s.configPath,
    "--proposal",
    s.proposalPath,
    "--patch",
    s.patchPath,
    "--approval-id",
    s.f.approval.approvalId,
  ]);
  assert.equal(result.code, 0, result.stderr);
  return (JSON.parse(result.stdout) as Json).attemptId as string;
}

function exportBundle(s: Setup, attemptId: string): Json {
  const result = cli([
    "export-evidence",
    "--config",
    s.configPath,
    "--attempt-id",
    attemptId,
  ]);
  assert.equal(result.code, 0, result.stderr);
  return JSON.parse(result.stdout) as Json;
}

function verify(
  s: Setup,
  bundle: unknown,
  options: { repositoryPath?: string; patch?: Uint8Array } = {},
  trust: unknown = s.trust,
): GitPromotionEvidenceReport {
  return verifyGitPromotionEvidence(
    JSON.parse(JSON.stringify(bundle)),
    trust,
    options,
  );
}

function failedAt(report: GitPromotionEvidenceReport): string | undefined {
  assert.equal(report.result, "failed", JSON.stringify(report));
  return report.checks.find((check) => !check.ok)?.check;
}

/** Re-digest and re-sign a manifest, as a host holding the key could. */
function resign(bundle: Json, key: KeyObject): Json {
  const manifestDigest = digestCanonical(bundle.manifest);
  return {
    ...bundle,
    manifestDigest,
    signature: {
      algorithm: "ed25519",
      value: sign(
        null,
        Buffer.from(`reprogate.git-promotion-evidence.v1\n${manifestDigest}`),
        key,
      ).toString("base64url"),
    },
  };
}

/** The same-length signature with one character in the middle changed. */
function flip(value: string): string {
  const middle = value.charAt(40) === "A" ? "B" : "A";
  return `${value.slice(0, 40)}${middle}${value.slice(41)}`;
}

function edit(bundle: Json, change: (manifest: Json) => void): Json {
  const copy = JSON.parse(JSON.stringify(bundle)) as Json;
  change(copy.manifest as Json);
  return copy;
}

function operatorKey(s: Setup): KeyObject {
  return createPrivateKey({
    key: Buffer.from(s.f.privateKeyBytes),
    format: "der",
    type: "pkcs8",
  });
}

/**
 * After a forged change to the manifest, re-derive the effect digest and
 * have the (colluding) operator key sign a matching review.
 */
function reReview(
  s: Setup,
  m: Json,
  change: (payload: GitOperatorReviewPayloadV1) => void = () => undefined,
): void {
  const attempt = m.attempt as Json;
  const prepared = attempt.prepared as Json;
  const effectDigest = digestCanonical(prepared.staged);
  prepared.effectDigest = effectDigest;
  attempt.effectDigest = effectDigest;
  const payload = {
    ...((m.review as Json).payload as GitOperatorReviewPayloadV1),
    effectDigest,
  };
  change(payload);
  m.review = signGitOperatorReview(payload, operatorKey(s));
  const reviewDigest = gitOperatorReviewDigest(payload);
  attempt.reviewDigest = reviewDigest;
  if (m.admission) (m.admission as Json).reviewDigest = reviewDigest;
}

/** Point every record at a different candidate commit in the repository. */
function setCandidate(s: Setup, m: Json, commit: string): void {
  const prepared = (m.attempt as Json).prepared as Json;
  prepared.candidateCommitOid = commit;
  prepared.hostCommitMetadataDigest = sha256(
    git(s.f.root, "cat-file", "commit", commit),
  );
  (m.admission as Json).candidateCommitOid = commit;
  (m.outcome as Json).observedDestinationOid = commit;
}

test("a confirmed promotion exports, and verifies offline with public keys only", (t) => {
  const s = setup(t);
  const attemptId = promote(s);
  const bundle = exportBundle(s, attemptId);
  const manifest = bundle.manifest as Json;
  assert.equal(manifest.attemptId, attemptId);
  assert.equal(manifest.hostKeyId, s.host.keyId);
  const attempt = manifest.attempt as Json;
  // Host-only fields stay home: the fence owner token is a local capability.
  assert.equal("repositoryPath" in attempt, false);
  assert.equal("fenceOwner" in attempt, false);
  assert.equal(JSON.stringify(bundle).includes(s.f.root), false);

  const unchecked = verify(s, bundle);
  assert.equal(unchecked.result, "unchecked_effect", JSON.stringify(unchecked));
  assert.equal(unchecked.outcome, "confirmed");
  assert.ok(unchecked.checks.every((check) => check.ok));

  // The tree diff computed offline matches the digest staging recorded.
  const verified = verify(s, bundle, { repositoryPath: s.f.root });
  assert.equal(verified.result, "verified", JSON.stringify(verified));
  assert.deepEqual(
    verified.checks.map((check) => check.check),
    [
      "manifest_digest",
      "host_signature",
      "review_links",
      "operator_review",
      "candidate_commit",
      "staged_diff",
    ],
  );
  const withPatch = verify(s, bundle, {
    repositoryPath: s.f.root,
    patch: s.f.patch,
  });
  assert.equal(withPatch.result, "verified", JSON.stringify(withPatch));
  assert.ok(withPatch.checks.some((check) => check.check === "patch_applies"));
  const patchOnly = verify(s, bundle, { patch: s.f.patch });
  assert.equal(patchOnly.result, "unchecked_effect");
  assert.ok(patchOnly.checks.some((check) => check.check === "patch_digest"));

  // The CLI needs no config, database or secret to verify.
  const bundlePath = join(s.f.scratch, "bundle.json");
  writeFileSync(bundlePath, JSON.stringify(bundle));
  const ok = cli([
    "verify-evidence",
    "--bundle",
    bundlePath,
    "--trust",
    s.trustPath,
    "--repo",
    s.f.root,
  ]);
  assert.equal(ok.code, 0, ok.stderr);
  assert.equal((JSON.parse(ok.stdout) as Json).result, "verified");
  const notOk = cli([
    "verify-evidence",
    "--bundle",
    bundlePath,
    "--trust",
    s.trustPath,
  ]);
  assert.equal(notOk.code, 1);
  assert.equal((JSON.parse(notOk.stdout) as Json).result, "unchecked_effect");
});

test("tampering is detected at the check that covers it", (t) => {
  const s = setup(t);
  const bundle = exportBundle(s, promote(s));
  const key = s.host.privateKey;

  // Any change without re-signing breaks the manifest digest.
  assert.equal(
    failedAt(
      verify(
        s,
        edit(bundle, (m) => (m.exportedAt = "2099-01-01T00:00:00.000Z")),
      ),
    ),
    "manifest_digest",
  );
  // A consistent digest signed by an untrusted key.
  assert.equal(
    failedAt(
      verify(
        s,
        resign(
          edit(bundle, () => undefined),
          keyPair().privateKey,
        ),
      ),
    ),
    "host_signature",
  );
  const signature = bundle.signature as Json;
  assert.equal(
    failedAt(
      verify(s, {
        ...bundle,
        signature: {
          ...signature,
          value: flip(String(signature.value)),
        },
      }),
    ),
    "host_signature",
  );

  // Even the trusted host cannot sign records that do not bind together.
  const lying: [string, (m: Json) => void][] = [
    [
      "manifest_schema",
      (m) => ((m.outcome as Json).observedDestinationOid = "0".repeat(40)),
    ],
    ["manifest_schema", (m) => ((m.coverage as Json).network = "enforced")],
    ["manifest_schema", (m) => (m.destinationRef = "refs/heads/other")],
    [
      "manifest_schema",
      (m) => ((m.attempt as Json).fenceOwner = { token: "x" }),
    ],
    [
      "manifest_schema",
      (m) =>
        ((((m.attempt as Json).prepared as Json).staged as Json).changedPaths =
          ["other.txt"]),
    ],
    ["manifest_schema", (m) => (m.exportedAt = "2000-01-01T00:00:00.000Z")],
    [
      "review_links",
      (m) => {
        const review = m.review as Json;
        (review.payload as Json).operatorId = "someone-else";
      },
    ],
    [
      "operator_review",
      (m) => {
        const review = m.review as Json;
        const value = String((review.signature as Json).value);
        (review.signature as Json).value = flip(value);
      },
    ],
  ];
  for (const [expected, change] of lying)
    assert.equal(
      failedAt(verify(s, resign(edit(bundle, change), key))),
      expected,
      change.toString(),
    );
});

test("trust decides which operators and hosts count", (t) => {
  const s = setup(t);
  const bundle = exportBundle(s, promote(s));
  const operators = s.trust.review.operators;
  const withOperators = (enabled: boolean, keyEnabled = true) => ({
    ...s.trust,
    review: {
      ...s.trust.review,
      operators: operators.map((operator) => ({
        ...operator,
        enabled,
        keys: operator.keys.map((key) => ({ ...key, enabled: keyEnabled })),
      })),
    },
  });
  assert.equal(
    failedAt(verify(s, bundle, {}, withOperators(false))),
    "operator_review",
  );
  assert.equal(
    failedAt(verify(s, bundle, {}, withOperators(true, false))),
    "operator_review",
  );
  assert.equal(
    failedAt(
      verify(
        s,
        bundle,
        {},
        {
          ...s.trust,
          review: { ...s.trust.review, audience: "another-host" },
        },
      ),
    ),
    "operator_review",
  );
  const operatorKey = operators[0]?.keys[0];
  assert.ok(operatorKey);
  assert.equal(
    failedAt(
      verify(
        s,
        bundle,
        {},
        {
          ...s.trust,
          hostKeys: [
            ...s.trust.hostKeys,
            {
              keyId: operatorKey.keyId,
              publicKeyPem: operatorKey.publicKeyPem,
            },
          ],
        },
      ),
    ),
    "trust",
  );
  const other = keyPair();
  assert.equal(
    failedAt(
      verify(
        s,
        bundle,
        {},
        {
          ...s.trust,
          hostKeys: [{ keyId: other.keyId, publicKeyPem: other.publicKeyPem }],
        },
      ),
    ),
    "host_signature",
  );
  assert.equal(
    failedAt(
      verify(
        s,
        bundle,
        {},
        {
          ...s.trust,
          hostKeys: [{ keyId: other.keyId, publicKeyPem: s.host.publicKeyPem }],
        },
      ),
    ),
    "trust",
  );
});

test("the effect check needs the real objects and the right patch", (t) => {
  const s = setup(t);
  const bundle = exportBundle(s, promote(s));
  const empty = mkdtempSync(join(tmpdir(), "reprogate-evidence-empty-"));
  t.after(() => {
    rmSync(empty, { recursive: true, force: true });
  });
  git(empty, "init", "--quiet");
  assert.equal(
    failedAt(verify(s, bundle, { repositoryPath: empty })),
    "candidate_commit",
  );
  const wrong = Buffer.concat([s.f.patch, Buffer.from("\n")]);
  assert.equal(
    failedAt(verify(s, bundle, { repositoryPath: s.f.root, patch: wrong })),
    "patch_digest",
  );
});

test("a staged diff digest that does not match the real trees is caught", (t) => {
  // Host and operator keys collude on a consistent, fully signed bundle whose
  // recorded diff is not what the candidate tree contains.
  const s = setup(t);
  const bundle = exportBundle(s, promote(s));
  const operatorKey = createPrivateKey({
    key: Buffer.from(s.f.privateKeyBytes),
    format: "der",
    type: "pkcs8",
  });
  const forged = edit(bundle, (m) => {
    const attempt = m.attempt as Json;
    const prepared = attempt.prepared as Json;
    const staged = prepared.staged as Json;
    staged.stagedPatchDigest = `sha256:${"a".repeat(64)}`;
    const effectDigest = digestCanonical(staged);
    prepared.effectDigest = effectDigest;
    attempt.effectDigest = effectDigest;
    const payload = {
      ...((m.review as Json).payload as GitOperatorReviewPayloadV1),
      effectDigest,
    };
    m.review = signGitOperatorReview(payload, operatorKey);
    const reviewDigest = gitOperatorReviewDigest(payload);
    attempt.reviewDigest = reviewDigest;
    (m.admission as Json).reviewDigest = reviewDigest;
  });
  const signed = resign(forged, s.host.privateKey);
  // Without the repository, nothing contradicts the signed records.
  assert.equal(verify(s, signed).result, "unchecked_effect");
  assert.equal(
    failedAt(verify(s, signed, { repositoryPath: s.f.root })),
    "staged_diff",
  );
});

test("a failed attempt verifies as not promoted; nothing in flight exports", (t) => {
  const s = setup(t);
  reserve(s.f);
  const inFlight = cli([
    "export-evidence",
    "--config",
    s.configPath,
    "--attempt-id",
    s.f.prepared.attemptId,
  ]);
  assert.equal(inFlight.code, 1);
  assert.match(inFlight.stderr, /Only a resolved promotion attempt/u);
  const recovered = cli([
    "recover",
    "--config",
    s.configPath,
    "--attempt-id",
    s.f.prepared.attemptId,
    "--confirm-quiescent",
  ]);
  assert.equal(recovered.code, 0, recovered.stderr);
  const bundle = exportBundle(s, s.f.prepared.attemptId);
  assert.equal((bundle.manifest as Json).admission, undefined);
  const report = verify(s, bundle, { repositoryPath: s.f.root });
  assert.equal(report.result, "not_promoted", JSON.stringify(report));
  assert.equal(report.outcome, "failed");
  assert.ok(report.checks.every((check) => check.ok));
});

test("export needs its own key, distinct from every operator key", (t) => {
  const none = setup(t, { evidence: false });
  const attemptId = promote(none);
  const missing = cli([
    "export-evidence",
    "--config",
    none.configPath,
    "--attempt-id",
    attemptId,
  ]);
  assert.equal(missing.code, 1);
  assert.match(missing.stderr, /evidence\.signingKeyPath/u);

  const s = setup(t);
  const id = promote(s);
  const keyPath = join(s.f.scratch, "operator-as-evidence.pem");
  writeFileSync(keyPath, createPrivatePem(s.f.privateKeyBytes), {
    mode: 0o600,
  });
  writeFileSync(
    s.configPath,
    JSON.stringify({ ...s.config, evidence: { signingKeyPath: keyPath } }),
    { mode: 0o600 },
  );
  const reused = cli([
    "export-evidence",
    "--config",
    s.configPath,
    "--attempt-id",
    id,
  ]);
  assert.equal(reused.code, 1);
  assert.match(reused.stderr, /must not be an operator key/u);
  const unknown = cli([
    "export-evidence",
    "--config",
    s.configPath,
    "--attempt-id",
    "00000000-0000-4000-8000-000000000000",
  ]);
  assert.equal(unknown.code, 1);
  assert.equal(unknown.stdout, '{"found":false}\n');
});

function createPrivatePem(der: Uint8Array): string {
  return `-----BEGIN PRIVATE KEY-----\n${Buffer.from(der).toString("base64")}\n-----END PRIVATE KEY-----\n`;
}

test("exported bundles match the published JSON Schema", (t) => {
  const s = setup(t);
  const bundle = exportBundle(s, promote(s));
  const read = (name: string) =>
    JSON.parse(
      readFileSync(
        new URL(`../../schemas/${name}.schema.json`, import.meta.url),
        "utf8",
      ),
    ) as object;
  const validate = new Ajv2020({ strict: true })
    .addSchema(read("git-operator-review"))
    .addSchema(read("git-promotion-admission"))
    .addSchema(read("git-promotion-outcome"))
    .addSchema(read("git-promotion-evidence"))
    .getSchema("https://reprogate.dev/schemas/git-promotion-evidence-v1.json");
  assert.ok(validate);
  assert.equal(validate(bundle), true, JSON.stringify(validate.errors));
  const attempt = (bundle.manifest as Json).attempt as Json;
  assert.equal(
    validate(
      edit(bundle, (m) => (m.attempt = { ...attempt, repositoryPath: "/x" })),
    ),
    false,
  );
});

test("the review must be valid at reservation and admission, not at verification", (t) => {
  const s = setup(t);
  const bundle = exportBundle(s, promote(s));
  // Long after the review expired, the bundle still verifies.
  t.mock.method(Date, "now", () => Date.parse("2099-01-01T00:00:00.000Z"));
  assert.equal(
    verify(s, bundle, { repositoryPath: s.f.root }).result,
    "verified",
  );
  t.mock.restoreAll();

  const payload = (bundle.manifest as Json).review as Json;
  const issuedAt = Date.parse(String((payload.payload as Json).issuedAt));
  const attempt = (bundle.manifest as Json).attempt as Json;
  const created = Date.parse(String((attempt.proposal as Json).createdAt));
  assert.ok(created < issuedAt - 1);
  // A host claiming it reserved and admitted before the review existed.
  const early = new Date(issuedAt - 1).toISOString();
  const backdated = edit(bundle, (m) => {
    const a = m.attempt as Json;
    (a.prepared as Json).createdAt = early;
    a.precheckedAt = early;
    a.reservedAt = early;
    (m.admission as Json).admittedAt = early;
  });
  assert.equal(
    failedAt(verify(s, resign(backdated, s.host.privateKey))),
    "operator_review",
  );
  // Only the reservation backdated: admission alone would still pass.
  const reservedEarly = edit(bundle, (m) => {
    const a = m.attempt as Json;
    (a.prepared as Json).createdAt = early;
    a.precheckedAt = early;
    a.reservedAt = early;
  });
  assert.equal(
    failedAt(verify(s, resign(reservedEarly, s.host.privateKey))),
    "operator_review",
  );

  // A colluding operator key still cannot make these consistent.
  const denied = edit(bundle, (m) => {
    reReview(s, m, (p) => {
      p.decision = "deny";
    });
  });
  assert.equal(
    failedAt(verify(s, resign(denied, s.host.privateKey))),
    "review_links",
  );
  const short = edit(bundle, (m) => {
    const admittedAt = Date.parse(String((m.admission as Json).admittedAt));
    reReview(s, m, (p) => {
      p.expiresAt = new Date(admittedAt + 1).toISOString();
    });
  });
  assert.equal(
    failedAt(verify(s, resign(short, s.host.privateKey))),
    "review_links",
  );
});

test("the candidate commit must be exactly the staged tree on the expected parent", (t) => {
  const s = setup(t);
  const bundle = exportBundle(s, promote(s));
  const prepared = ((bundle.manifest as Json).attempt as Json).prepared as Json;
  const tree = String(prepared.candidateTreeOid);
  const parent = String(prepared.expectedOldOid);
  const other = git(s.f.root, "commit-tree", "-p", parent, "-m", "other", tree)
    .toString()
    .trim();
  const merge = git(
    s.f.root,
    "commit-tree",
    "-p",
    parent,
    "-p",
    other,
    "-m",
    "two parents",
    tree,
  )
    .toString()
    .trim();
  git(
    s.f.root,
    "tag",
    "-a",
    "-m",
    "tag",
    "evidence-tag",
    String(prepared.candidateCommitOid),
  );
  const tag = git(s.f.root, "rev-parse", "evidence-tag").toString().trim();
  const orphan = git(s.f.root, "commit-tree", "-p", other, "-m", "orphan", tree)
    .toString()
    .trim();
  const forgeries: [string, (m: Json) => void][] = [
    [
      "wrong parent",
      (m) => {
        setCandidate(s, m, orphan);
      },
    ],
    [
      "two parents",
      (m) => {
        setCandidate(s, m, merge);
      },
    ],
    [
      "wrong metadata",
      (m) => {
        ((m.attempt as Json).prepared as Json).hostCommitMetadataDigest =
          `sha256:${"b".repeat(64)}`;
      },
    ],
    [
      "tag object",
      (m) => {
        setCandidate(s, m, String(prepared.candidateCommitOid));
        const p = (m.attempt as Json).prepared as Json;
        p.candidateCommitOid = tag;
        (m.admission as Json).candidateCommitOid = tag;
        (m.outcome as Json).observedDestinationOid = tag;
      },
    ],
  ];
  for (const [name, change] of forgeries)
    assert.equal(
      failedAt(
        verify(s, resign(edit(bundle, change), s.host.privateKey), {
          repositoryPath: s.f.root,
        }),
      ),
      "candidate_commit",
      name,
    );
});

test("the patch must reproduce the staged tree the operator signed", (t) => {
  const s = setup(t);
  const bundle = exportBundle(s, promote(s));
  const prepared = ((bundle.manifest as Json).attempt as Json).prepared as Json;
  // A different tree: the staged one plus an extra file.
  const blob = execFileSync(
    "git",
    ["-C", s.f.root, "hash-object", "-w", "--stdin"],
    { input: "extra\n" },
  )
    .toString()
    .trim();
  const listing = git(s.f.root, "ls-tree", String(prepared.candidateTreeOid));
  const tree = execFileSync("git", ["-C", s.f.root, "mktree"], {
    input: Buffer.concat([
      listing,
      Buffer.from(`100644 blob ${blob}\textra.txt\n`),
    ]),
  })
    .toString()
    .trim();
  const commit = git(
    s.f.root,
    "commit-tree",
    "-p",
    String(prepared.expectedOldOid),
    "-m",
    "forged",
    tree,
  )
    .toString()
    .trim();
  // The staged diff digest of that tree, computed the way staging does.
  const scratch = mkdtempSync(join(tmpdir(), "reprogate-evidence-forge-"));
  t.after(() => {
    rmSync(scratch, { recursive: true, force: true });
  });
  git(scratch, "init", "--quiet");
  writeFileSync(
    join(scratch, ".git", "objects", "info", "alternates"),
    `${join(s.f.root, ".git", "objects")}\n`,
  );
  git(scratch, "read-tree", tree);
  const diff = git(
    scratch,
    "diff",
    "--cached",
    "--binary",
    "--no-ext-diff",
    "--no-textconv",
    String(prepared.baseCommit),
    "--",
  );
  const forged = edit(bundle, (m) => {
    const p = (m.attempt as Json).prepared as Json;
    const staged = p.staged as Json;
    staged.candidateTreeOid = tree;
    staged.stagedPatchDigest = sha256(diff);
    p.candidateTreeOid = tree;
    setCandidate(s, m, commit);
    reReview(s, m);
  });
  const signed = resign(forged, s.host.privateKey);
  // Everything about the commit is consistent; only the patch disagrees.
  assert.equal(
    verify(s, signed, { repositoryPath: s.f.root }).result,
    "verified",
  );
  assert.equal(
    failedAt(verify(s, signed, { repositoryPath: s.f.root, patch: s.f.patch })),
    "patch_applies",
  );
});

test("a fetched clone that only has the objects under remote refs verifies", (t) => {
  const s = setup(t);
  const clone = join(s.f.scratch, "verifier-clone");
  execFileSync("git", ["clone", "--quiet", "--no-checkout", s.f.root, clone]);
  const bundle = exportBundle(s, promote(s));
  git(clone, "fetch", "--quiet", "origin");
  const report = verify(s, bundle, { repositoryPath: clone, patch: s.f.patch });
  assert.equal(report.result, "verified", JSON.stringify(report));
});

test("encodings, keys and manifest shapes are strict", (t) => {
  const s = setup(t);
  const bundle = exportBundle(s, promote(s));
  const signature = bundle.signature as Json;
  const value = String(signature.value);
  const last = value.at(-1) ?? "A";
  // Same decoded bytes, different spelling of the unused low bits.
  const alias = String.fromCharCode(last.charCodeAt(0) + 1);
  assert.equal(
    failedAt(
      verify(s, {
        ...bundle,
        signature: { ...signature, value: `${value.slice(0, -1)}${alias}` },
      }),
    ),
    "bundle_schema",
  );
  assert.equal(
    failedAt(
      verify(
        s,
        JSON.parse(
          JSON.stringify(bundle).replace(
            '"manifest":{',
            '"manifest":{"__proto__":{"evil":"unsigned"},',
          ),
        ) as Json,
      ),
    ),
    "bundle_schema",
  );
  const privatePem = s.host.privateKey
    .export({ type: "pkcs8", format: "pem" })
    .toString();
  assert.equal(
    failedAt(
      verify(
        s,
        bundle,
        {},
        {
          ...s.trust,
          hostKeys: [{ keyId: s.host.keyId, publicKeyPem: privatePem }],
        },
      ),
    ),
    "trust",
  );
  // A missing required option is still a usage error for other commands.
  const usage = cli([
    "promote",
    "--config",
    s.configPath,
    "--proposal",
    s.proposalPath,
    "--approval-id",
    s.f.approval.approvalId,
  ]);
  assert.equal(usage.code, 2);
  assert.match(usage.stderr, /Missing required option --patch/u);
});
