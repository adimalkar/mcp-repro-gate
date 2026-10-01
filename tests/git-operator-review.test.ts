import assert from "node:assert/strict";
import {
  createPublicKey,
  createSecretKey,
  generateKeyPairSync,
  sign,
  verify,
} from "node:crypto";
import { readFileSync } from "node:fs";
import test from "node:test";

import { Ajv2020 } from "ajv/dist/2020.js";

import { canonicalJson } from "../src/canonical-json.js";
import { digestCanonical, sha256 } from "../src/digest.js";
import type { GitApprovalAuthority } from "../src/git-approval-store.js";
import type { GitChangeProposalV1 } from "../src/git-change-proposal.js";
import {
  authenticateGitOperatorReview,
  gitOperatorKeyId,
  gitOperatorReviewDigest,
  parseGitOperatorReview,
  parseGitOperatorReviewPayload,
  parseGitOperatorReviewTrust,
  signGitOperatorReview,
  verifyGitOperatorReview,
  type GitOperatorReviewPayloadV1,
  type GitOperatorReviewTrustV1,
} from "../src/git-operator-review.js";

const DOMAIN = "ReproGate/GitOperatorReview/v1\0";
const pair = generateKeyPairSync("ed25519");
const otherPair = generateKeyPairSync("ed25519");
const now = Date.now();
const iso = (offset: number) => new Date(now + offset).toISOString();

function fixture() {
  const unsigned = {
    proposalVersion: 1 as const,
    repositoryId: "example/repository",
    actionId: sha256("action"),
    policyDigest: sha256("policy"),
    workspace: {
      source: "git_observed" as const,
      rootDigest: sha256("root"),
      headCommit: "a".repeat(40),
      headTree: "b".repeat(40),
      destinationRef: "refs/heads/main",
      destinationOid: "a".repeat(40),
      status: "clean" as const,
    },
    patchDigest: sha256("patch"),
    allowedPaths: ["src/value.txt"],
    createdAt: iso(-60_000),
    expiresAt: iso(3_600_000),
  };
  const proposal: GitChangeProposalV1 = {
    ...unsigned,
    proposalId: digestCanonical(unsigned),
  };
  const authority: GitApprovalAuthority = {
    repositoryId: proposal.repositoryId,
    actionId: proposal.actionId,
    policyDigest: proposal.policyDigest,
    workspaceRootDigest: proposal.workspace.rootDigest,
    destinationRef: proposal.workspace.destinationRef,
    maxExpiresAt: iso(3_600_000),
  };
  const effectDigest = sha256("staged effect");
  const payload: GitOperatorReviewPayloadV1 = {
    reviewVersion: 1,
    audience: "reprogate:host-1",
    operatorId: "alice",
    keyId: gitOperatorKeyId(pair.publicKey),
    decision: "approve",
    proposalId: proposal.proposalId,
    authorityDigest: digestCanonical(authority),
    effectDigest,
    issuedAt: iso(-1_000),
    expiresAt: iso(600_000),
  };
  const trust: GitOperatorReviewTrustV1 = {
    audience: payload.audience,
    maxReviewTtlMs: 900_000,
    operators: [
      {
        operatorId: payload.operatorId,
        enabled: true,
        keys: [
          {
            keyId: payload.keyId,
            publicKeyPem: pair.publicKey
              .export({ type: "spki", format: "pem" })
              .toString(),
            enabled: true,
          },
        ],
        permissions: [
          {
            repositoryId: authority.repositoryId,
            workspaceRootDigest: authority.workspaceRootDigest,
            destinationRef: authority.destinationRef,
          },
        ],
      },
    ],
  };
  const review = signGitOperatorReview(payload, pair.privateKey);
  const authenticate = (value: unknown, hostTrust: unknown = trust) =>
    authenticateGitOperatorReview(
      value,
      proposal,
      authority,
      effectDigest,
      hostTrust,
    );
  const accepts = (value: unknown, hostTrust: unknown = trust) =>
    verifyGitOperatorReview(
      value,
      proposal,
      authority,
      effectDigest,
      hostTrust,
    );
  const operator = trust.operators[0];
  assert.ok(operator);
  const key = operator.keys[0];
  const permission = operator.permissions[0];
  assert.ok(key);
  assert.ok(permission);
  return {
    proposal,
    authority,
    effectDigest,
    payload,
    trust,
    review,
    authenticate,
    accepts,
    operator,
    key,
    permission,
  };
}

function rawReview(payload: unknown, domain = DOMAIN) {
  return {
    payload,
    signature: {
      algorithm: "ed25519",
      value: sign(
        null,
        Buffer.from(domain + canonicalJson(payload)),
        pair.privateKey,
      ).toString("base64url"),
    },
  };
}

function reidentify(proposal: GitChangeProposalV1): GitChangeProposalV1 {
  const unsigned = Object.fromEntries(
    Object.entries(proposal).filter(([key]) => key !== "proposalId"),
  );
  return { ...proposal, proposalId: digestCanonical(unsigned) };
}

test("real Ed25519 signatures bind domain-separated canonical payload bytes and public SPKI", () => {
  const f = fixture();
  const bytes = Buffer.from(DOMAIN + canonicalJson(f.payload));
  assert.equal(f.accepts(f.review), true);
  assert.equal(gitOperatorReviewDigest(f.payload), sha256(bytes));
  assert.equal(
    gitOperatorKeyId(pair.publicKey),
    sha256(pair.publicKey.export({ type: "spki", format: "der" })),
  );
  assert.notEqual(gitOperatorKeyId(pair.publicKey), sha256(f.key.publicKeyPem));
  assert.equal(
    verify(
      null,
      bytes,
      pair.publicKey,
      Buffer.from(f.review.signature.value, "base64url"),
    ),
    true,
  );
  for (const domain of [
    "",
    "ReproGate/GitOperatorReview/v1",
    "ReproGate/GitOperatorReview/v1\\0",
    "ReproGate/GitOperatorReview/v2\0",
  ]) {
    assert.equal(f.accepts(rawReview(f.payload, domain)), false, domain);
  }
  assert.deepEqual(
    signGitOperatorReview(
      Object.fromEntries(Object.entries(f.payload).reverse()),
      pair.privateKey,
    ),
    f.review,
  );
  const denied = signGitOperatorReview(
    { ...f.payload, decision: "deny" },
    pair.privateKey,
  );
  assert.equal(
    f.accepts(denied),
    true,
    "verification authenticates deny; it does not grant approval",
  );
});

test("every signed field mutation invalidates the original signature", () => {
  const f = fixture();
  const mutations = {
    reviewVersion: 2,
    audience: "reprogate:host-2",
    operatorId: "bob",
    keyId: gitOperatorKeyId(otherPair.publicKey),
    decision: "deny",
    proposalId: sha256("another proposal"),
    authorityDigest: sha256("another authority"),
    effectDigest: sha256("another effect"),
    issuedAt: iso(-2_000),
    expiresAt: iso(500_000),
  };
  assert.deepEqual(
    Object.keys(mutations).sort(),
    Object.keys(f.payload).sort(),
  );
  for (const [field, value] of Object.entries(mutations)) {
    assert.equal(
      f.accepts({ ...f.review, payload: { ...f.payload, [field]: value } }),
      false,
      field,
    );
  }
});

test("valid signatures do not bypass proposal, authority, effect, audience, or principal bindings", () => {
  const f = fixture();
  for (const change of [
    { audience: "wrong-host" },
    { operatorId: "bob" },
    { proposalId: sha256("wrong") },
    { authorityDigest: sha256("wrong") },
    { effectDigest: sha256("wrong") },
  ]) {
    assert.equal(
      f.accepts(
        signGitOperatorReview({ ...f.payload, ...change }, pair.privateKey),
      ),
      false,
    );
  }
  assert.equal(
    verifyGitOperatorReview(
      f.review,
      { ...f.proposal, allowedPaths: ["tampered"] },
      f.authority,
      f.effectDigest,
      f.trust,
    ),
    false,
  );
  assert.equal(
    verifyGitOperatorReview(
      f.review,
      f.proposal,
      f.authority,
      sha256("different staged effect"),
      f.trust,
    ),
    false,
  );
  for (const change of [
    { repositoryId: "wrong" },
    { actionId: sha256("wrong") },
    { policyDigest: sha256("wrong") },
    { workspaceRootDigest: sha256("wrong") },
    { destinationRef: "refs/heads/other" },
  ]) {
    const authority = { ...f.authority, ...change };
    const review = signGitOperatorReview(
      { ...f.payload, authorityDigest: digestCanonical(authority) },
      pair.privateKey,
    );
    assert.equal(
      verifyGitOperatorReview(
        review,
        f.proposal,
        authority,
        f.effectDigest,
        f.trust,
      ),
      false,
    );
  }
});

test("current host allowlist exclusively controls enabled identity, keys and exact scope", () => {
  const f = fixture();
  const { operator, key, permission } = f;
  for (const trust of [
    { ...f.trust, audience: "other-host" },
    { ...f.trust, operators: [] },
    { ...f.trust, operators: [{ ...operator, operatorId: "bob" }] },
    { ...f.trust, operators: [{ ...operator, enabled: false }] },
    { ...f.trust, operators: [{ ...operator, keys: [] }] },
    {
      ...f.trust,
      operators: [{ ...operator, keys: [{ ...key, enabled: false }] }],
    },
    {
      ...f.trust,
      operators: [
        {
          ...operator,
          keys: [
            {
              ...key,
              keyId: gitOperatorKeyId(otherPair.publicKey),
              publicKeyPem: otherPair.publicKey
                .export({ type: "spki", format: "pem" })
                .toString(),
            },
          ],
        },
      ],
    },
    { ...f.trust, operators: [{ ...operator, permissions: [] }] },
    ...[
      { repositoryId: "other" },
      { workspaceRootDigest: sha256("other-root") },
      { destinationRef: "refs/heads/other" },
    ].map((change) => ({
      ...f.trust,
      operators: [{ ...operator, permissions: [{ ...permission, ...change }] }],
    })),
  ]) {
    assert.equal(f.accepts(f.review, trust), false);
  }
  assert.equal(
    f.accepts({ ...f.review, principal: "alice", authenticated: true }),
    false,
  );
  assert.equal(f.accepts({ ...f.review, trust: f.trust }), false);
});

test("strict parsing rejects malformed tokens, missing/extra fields and unsupported contracts", () => {
  const f = fixture();
  for (const value of [
    null,
    [],
    {},
    { payload: f.payload },
    { ...f.review, extra: true },
    { ...f.review, signature: { ...f.review.signature, extra: true } },
    { ...f.review, signature: { ...f.review.signature, algorithm: "rsa" } },
  ]) {
    assert.throws(() => parseGitOperatorReview(value));
    assert.equal(f.accepts(value), false);
  }
  for (const field of Object.keys(f.payload)) {
    const value = Object.fromEntries(
      Object.entries(f.payload).filter(([key]) => key !== field),
    );
    assert.throws(() => parseGitOperatorReviewPayload(value), field);
  }
  for (const payload of [
    { ...f.payload, extra: true },
    { ...f.payload, reviewVersion: 2 },
    { ...f.payload, decision: "yes" },
    { ...f.payload, audience: "" },
    { ...f.payload, audience: "host\n" },
    { ...f.payload, operatorId: " alice " },
    { ...f.payload, operatorId: "a".repeat(257) },
    ...["keyId", "proposalId", "authorityDigest", "effectDigest"].flatMap(
      (field) => [
        { ...f.payload, [field]: `sha256:${"A".repeat(64)}` },
        { ...f.payload, [field]: "sha256:1234" },
        { ...f.payload, [field]: `${sha256("x")}\n` },
      ],
    ),
  ]) {
    assert.throws(() => parseGitOperatorReviewPayload(payload));
    assert.equal(f.accepts(rawReview(payload)), false);
  }
});

test("signature parsing requires canonical unpadded base64url of exactly 64 bytes", () => {
  const f = fixture();
  const signature = f.review.signature.value;
  const alphabet =
    "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
  const final = alphabet.indexOf(signature.slice(-1));
  const noncanonical = signature.slice(0, -1) + alphabet.charAt(final + 1);
  assert.deepEqual(
    Buffer.from(noncanonical, "base64url"),
    Buffer.from(signature, "base64url"),
  );
  for (const value of [
    "",
    signature + "=",
    signature + "\n",
    signature.slice(1),
    "A".repeat(85),
    "A".repeat(87),
    noncanonical,
    "!" + signature.slice(1),
    Buffer.alloc(64).toString("base64"),
    Buffer.alloc(63).toString("base64url"),
    Buffer.alloc(65).toString("base64url"),
    "A".repeat(10_000),
  ]) {
    const review = { ...f.review, signature: { algorithm: "ed25519", value } };
    assert.throws(() => parseGitOperatorReview(review), value.slice(0, 90));
    assert.equal(f.accepts(review), false);
  }
  const corrupt = (signature.startsWith("A") ? "B" : "A") + signature.slice(1);
  assert.equal(
    f.accepts({
      ...f.review,
      signature: { algorithm: "ed25519", value: corrupt },
    }),
    false,
  );
});

test("canonical UTC timestamps and inclusive/exclusive chronology and TTL boundaries", (context) => {
  const f = fixture();
  context.mock.method(Date, "now", () => now);
  for (const change of [
    { issuedAt: iso(1) },
    { issuedAt: iso(-60_001) },
    { expiresAt: iso(0) },
    { expiresAt: iso(-1_000) },
    { expiresAt: iso(3_600_001) },
    { issuedAt: "2026-02-30T00:00:00.000Z" },
    {
      issuedAt: f.payload.issuedAt
        .replace(".000Z", "Z")
        .replace(/\.\d{3}Z$/u, "Z"),
    },
    { expiresAt: f.payload.expiresAt.replace("Z", "+00:00") },
    { expiresAt: "not a date" },
    { expiresAt: "2026-01-01T00:00:00.000Z\n" },
    { issuedAt: f.payload.issuedAt.toLowerCase() },
  ]) {
    assert.equal(
      f.accepts(rawReview({ ...f.payload, ...change })),
      false,
      JSON.stringify(change),
    );
  }
  assert.equal(
    f.accepts(
      signGitOperatorReview(
        { ...f.payload, issuedAt: iso(0) },
        pair.privateKey,
      ),
    ),
    true,
  );
  assert.equal(
    f.accepts(
      signGitOperatorReview(
        { ...f.payload, issuedAt: f.proposal.createdAt },
        pair.privateKey,
      ),
    ),
    true,
  );
  assert.equal(
    f.accepts(f.review, { ...f.trust, maxReviewTtlMs: 601_000 }),
    true,
  );
  assert.equal(
    f.accepts(f.review, { ...f.trust, maxReviewTtlMs: 600_999 }),
    false,
  );
  context.mock.method(Date, "now", () => Date.parse(f.payload.expiresAt));
  assert.equal(f.accepts(f.review), false, "expiry is exclusive");
  context.mock.method(Date, "now", () => Date.parse(f.payload.expiresAt) - 1);
  assert.equal(f.accepts(f.review), true, "last live millisecond");
  context.mock.method(Date, "now", () => now);
  const boundary = signGitOperatorReview(
    { ...f.payload, expiresAt: f.proposal.expiresAt },
    pair.privateKey,
  );
  assert.equal(
    f.accepts(boundary, { ...f.trust, maxReviewTtlMs: 3_601_000 }),
    true,
  );
  const authority = { ...f.authority, maxExpiresAt: iso(599_999) };
  assert.equal(
    verifyGitOperatorReview(
      signGitOperatorReview(
        { ...f.payload, authorityDigest: digestCanonical(authority) },
        pair.privateKey,
      ),
      f.proposal,
      authority,
      f.effectDigest,
      f.trust,
    ),
    false,
  );
  for (const change of [
    { createdAt: iso(1) },
    { createdAt: "bad" },
    { expiresAt: f.proposal.expiresAt.replace("Z", "+00:00") },
  ]) {
    const proposal = reidentify({ ...f.proposal, ...change });
    assert.equal(
      verifyGitOperatorReview(
        rawReview({ ...f.payload, proposalId: proposal.proposalId }),
        proposal,
        f.authority,
        f.effectDigest,
        f.trust,
      ),
      false,
    );
  }
});

test("signing and trust validation reject wrong crypto types, mismatched fingerprints and private material", () => {
  const f = fixture();
  const rsa = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const ec = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  const x = generateKeyPairSync("x25519");
  for (const key of [
    pair.publicKey,
    rsa.privateKey,
    ec.privateKey,
    x.privateKey,
    createSecretKey(Buffer.alloc(32)),
  ]) {
    assert.throws(() => signGitOperatorReview(f.payload, key));
  }
  assert.throws(() =>
    signGitOperatorReview(
      { ...f.payload, keyId: gitOperatorKeyId(otherPair.publicKey) },
      pair.privateKey,
    ),
  );
  for (const key of [
    pair.privateKey,
    rsa.publicKey,
    ec.publicKey,
    x.publicKey,
    createSecretKey(Buffer.alloc(32)),
  ]) {
    assert.throws(() => gitOperatorKeyId(key));
  }
  const { operator, key } = f;
  for (const publicKeyPem of [
    "garbage",
    "a".repeat(4097),
    pair.privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
    rsa.publicKey.export({ type: "spki", format: "pem" }).toString(),
    ec.publicKey.export({ type: "spki", format: "pem" }).toString(),
    x.publicKey.export({ type: "spki", format: "pem" }).toString(),
    otherPair.publicKey.export({ type: "spki", format: "pem" }).toString(),
    key.publicKeyPem +
      pair.privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
  ]) {
    const trust = {
      ...f.trust,
      operators: [{ ...operator, keys: [{ ...key, publicKeyPem }] }],
    };
    assert.throws(
      () => parseGitOperatorReviewTrust(trust),
      (error: unknown) =>
        error instanceof Error && !error.message.includes("BEGIN PRIVATE KEY"),
    );
    assert.equal(f.accepts(f.review, trust), false);
  }
  const crlf = {
    ...f.trust,
    operators: [
      {
        ...operator,
        keys: [
          { ...key, publicKeyPem: key.publicKeyPem.replaceAll("\n", "\r\n") },
        ],
      },
    ],
  };
  assert.equal(f.accepts(f.review, crlf), true);
  assert.equal(
    gitOperatorKeyId(createPublicKey(pair.privateKey)),
    f.payload.keyId,
  );
});

test("trust declarations are strict, bounded, explicit, unique and never glob permissions", () => {
  const f = fixture();
  const { operator: op, key, permission } = f;
  const invalid: unknown[] = [
    { ...f.trust, extra: true },
    ...[0, -1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1].map(
      (maxReviewTtlMs) => ({
        ...f.trust,
        maxReviewTtlMs,
      }),
    ),
    { ...f.trust, operators: [op, op] },
    { ...f.trust, operators: [op, { ...op, operatorId: "bob" }] },
    {
      ...f.trust,
      operators: Array.from({ length: 257 }, (_, index) => ({
        operatorId: `operator-${String(index)}`,
        enabled: true,
        keys: [],
        permissions: [],
      })),
    },
    {
      ...f.trust,
      operators: [
        {
          ...op,
          permissions: Array.from({ length: 257 }, (_, index) => ({
            ...permission,
            repositoryId: `repo-${String(index)}`,
          })),
        },
      ],
    },
    { ...f.trust, operators: [{ ...op, enabled: undefined }] },
    { ...f.trust, operators: [{ ...op, enabled: "true" }] },
    { ...f.trust, operators: [{ ...op, extra: true }] },
    { ...f.trust, operators: [{ ...op, keys: [key, key] }] },
    {
      ...f.trust,
      operators: [{ ...op, keys: [{ ...key, enabled: undefined }] }],
    },
    { ...f.trust, operators: [{ ...op, keys: [{ ...key, extra: true }] }] },
    {
      ...f.trust,
      operators: [{ ...op, permissions: [permission, permission] }],
    },
    ...[
      { repositoryId: "example/*" },
      { repositoryId: "example/{one,two}" },
      { destinationRef: "refs/heads/*" },
      { destinationRef: "refs/heads/../main" },
      { destinationRef: "refs/heads/main.lock" },
      { destinationRef: "refs/heads/main/" },
      { destinationRef: "refs/heads/main\n" },
      { destinationRef: "refs/heads/.hidden" },
      { destinationRef: "refs/heads/a/.hidden" },
      { destinationRef: "refs/heads/a//main" },
      { destinationRef: "refs/heads/a." },
      { destinationRef: "refs/heads/a?" },
      { destinationRef: "refs/heads/a[1]" },
      { destinationRef: "refs/heads/a@{1}" },
      { destinationRef: "refs/heads/" + "a".repeat(1024) },
      { workspaceRootDigest: "sha256:*" },
      { extra: true },
    ].map((change) => ({
      ...f.trust,
      operators: [{ ...op, permissions: [{ ...permission, ...change }] }],
    })),
  ];
  for (const trust of invalid) {
    assert.throws(() => parseGitOperatorReviewTrust(trust));
    assert.equal(f.accepts(f.review, trust), false);
  }
  const keys = Array.from({ length: 65 }, () => {
    const { publicKey } = generateKeyPairSync("ed25519");
    return {
      keyId: gitOperatorKeyId(publicKey),
      enabled: true,
      publicKeyPem: publicKey
        .export({ type: "spki", format: "pem" })
        .toString(),
    };
  });
  assert.throws(() =>
    parseGitOperatorReviewTrust({ ...f.trust, operators: [{ ...op, keys }] }),
  );
});

test("host trust schema enforces structure while library also validates actual public key identity", () => {
  const f = fixture();
  const schema = JSON.parse(
    readFileSync("schemas/git-operator-review.schema.json", "utf8"),
  ) as object;
  const ajv = new Ajv2020({ strict: true }).addSchema(schema);
  const validate = ajv.getSchema(
    "https://reprogate.dev/schemas/git-operator-review-v1.json#/$defs/trust",
  );
  assert.ok(validate);
  for (const value of [
    f.trust,
    { ...f.trust, operators: [] },
    { ...f.trust, operators: [{ ...f.operator, enabled: false }] },
    null,
    {},
    { ...f.trust, extra: true },
    { ...f.trust, maxReviewTtlMs: 0 },
    { ...f.trust, maxReviewTtlMs: 1.5 },
    { ...f.trust, operators: [{ ...f.operator, enabled: undefined }] },
    {
      ...f.trust,
      operators: [{ ...f.operator, keys: [{ ...f.key, enabled: undefined }] }],
    },
    {
      ...f.trust,
      operators: [
        {
          ...f.operator,
          permissions: [{ ...f.permission, destinationRef: "refs/heads/*" }],
        },
      ],
    },
    {
      ...f.trust,
      operators: [
        {
          ...f.operator,
          permissions: [{ ...f.permission, repositoryId: "repo/*" }],
        },
      ],
    },
  ]) {
    let parses = true;
    try {
      parseGitOperatorReviewTrust(value);
    } catch {
      parses = false;
    }
    assert.equal(validate(value), parses, JSON.stringify(value));
  }
  const mismatched = {
    ...f.trust,
    operators: [
      {
        ...f.operator,
        keys: [
          {
            ...f.key,
            keyId: gitOperatorKeyId(otherPair.publicKey),
            enabled: false,
          },
        ],
      },
    ],
  };
  assert.equal(
    validate(mismatched),
    true,
    "schema does not authenticate fingerprints",
  );
  assert.throws(
    () => parseGitOperatorReviewTrust(mismatched),
    "disabled keys must still be valid declarations",
  );
});

test("JSON schema and strict parser agree on review structural validation without AJV formats", () => {
  const f = fixture();
  const schema = JSON.parse(
    readFileSync("schemas/git-operator-review.schema.json", "utf8"),
  ) as object;
  const validate = new Ajv2020({ strict: true }).compile(schema);
  const structural: unknown[] = [
    f.review,
    rawReview({ ...f.payload, decision: "deny" }),
    null,
    {},
    { ...f.review, extra: true },
    { ...f.review, payload: { ...f.payload, extra: true } },
    { ...f.review, payload: { ...f.payload, audience: "" } },
    { ...f.review, payload: { ...f.payload, audience: "host\n" } },
    { ...f.review, payload: { ...f.payload, audience: "a".repeat(257) } },
    { ...f.review, payload: { ...f.payload, reviewVersion: 2 } },
    { ...f.review, payload: { ...f.payload, keyId: "sha256:ABC" } },
    { ...f.review, payload: { ...f.payload, issuedAt: "2026-01-01" } },
    {
      ...f.review,
      signature: {
        algorithm: "ed25519",
        value: f.review.signature.value + "=",
      },
    },
    {
      ...f.review,
      signature: { algorithm: "rsa", value: f.review.signature.value },
    },
    { ...f.review, signature: { ...f.review.signature, extra: true } },
    ...Object.keys(f.payload).map((field) => {
      const payload = Object.fromEntries(
        Object.entries(f.payload).filter(([key]) => key !== field),
      );
      return { ...f.review, payload };
    }),
  ];
  for (const value of structural) {
    let parses = true;
    try {
      parseGitOperatorReview(value);
    } catch {
      parses = false;
    }
    assert.equal(validate(value), parses, JSON.stringify(value));
  }
  assert.equal(
    validate(
      rawReview({
        ...f.payload,
        effectDigest: sha256("structurally valid but unbound"),
      }),
    ),
    true,
  );
  assert.equal(
    f.accepts(
      rawReview({
        ...f.payload,
        effectDigest: sha256("structurally valid but unbound"),
      }),
    ),
    false,
  );
});

test("authenticated review decision remains the signed deny for a switching payload getter", () => {
  const f = fixture();
  const denied = signGitOperatorReview(
    { ...f.payload, decision: "deny" },
    pair.privateKey,
  );
  const unsignedApproval = { ...denied.payload, decision: "approve" as const };
  let reads = 0;
  const source = {
    get payload() {
      reads += 1;
      return reads === 1 ? denied.payload : unsignedApproval;
    },
    signature: denied.signature,
  };
  const input: unknown = source;
  assert.equal(Object.keys(source).includes("payload"), true);
  assert.equal(
    verify(
      null,
      Buffer.from(DOMAIN + canonicalJson(denied.payload)),
      pair.publicKey,
      Buffer.from(denied.signature.value, "base64url"),
    ),
    true,
  );
  assert.equal(
    verify(
      null,
      Buffer.from(DOMAIN + canonicalJson(unsignedApproval)),
      pair.publicKey,
      Buffer.from(denied.signature.value, "base64url"),
    ),
    false,
  );
  const authenticated = f.authenticate(input);
  assert.ok(authenticated, "the signed deny must authenticate");
  assert.equal(reads, 1);
  assert.equal(authenticated.payload.decision, "deny");
  assert.equal(source.payload.decision, "approve");
  assert.equal(reads, 2);
  assert.equal(authenticated.payload.decision, "deny");
  assert.notStrictEqual(authenticated, source);
  assert.notStrictEqual(authenticated.payload, denied.payload);
  assert.notStrictEqual(authenticated.signature, denied.signature);
  assert.equal(f.accepts(authenticated), true);
  assert.equal(f.accepts(source), false);
});

test("authenticated snapshots isolate nested payload and signature accessors", () => {
  const f = fixture();
  const denied = signGitOperatorReview(
    { ...f.payload, decision: "deny" },
    pair.privateKey,
  );
  let decisionReads = 0;
  let signatureReads = 0;
  const source = {
    payload: {
      ...denied.payload,
      get decision() {
        decisionReads += 1;
        return decisionReads === 1 ? "deny" : "approve";
      },
    },
    signature: {
      algorithm: "ed25519",
      get value() {
        signatureReads += 1;
        return signatureReads === 1
          ? denied.signature.value
          : f.review.signature.value;
      },
    },
  };
  const authenticated = f.authenticate(source);
  assert.ok(authenticated);
  assert.equal(decisionReads, 1);
  assert.equal(signatureReads, 1);
  assert.equal(authenticated.payload.decision, "deny");
  assert.equal(authenticated.signature.value, denied.signature.value);
  assert.equal(source.payload.decision, "approve");
  assert.equal(source.signature.value, f.review.signature.value);
  assert.equal(authenticated.payload.decision, "deny");
  assert.equal(authenticated.signature.value, denied.signature.value);
  assert.notStrictEqual(authenticated.payload, source.payload);
  assert.notStrictEqual(authenticated.signature, source.signature);
  assert.equal(f.accepts(authenticated), true);
});

test("authenticated snapshots are deeply frozen without freezing or aliasing mutable sources", () => {
  const f = fixture();
  const source = structuredClone(f.review);
  const authenticated = f.authenticate(source);
  assert.ok(authenticated);
  assert.notStrictEqual(authenticated, source);
  assert.notStrictEqual(authenticated.payload, source.payload);
  assert.notStrictEqual(authenticated.signature, source.signature);
  for (const object of [
    authenticated,
    authenticated.payload,
    authenticated.signature,
  ]) {
    assert.equal(Object.isFrozen(object), true);
    assert.equal(Reflect.set(object, "extra", true), false);
  }
  for (const object of [source, source.payload, source.signature]) {
    assert.equal(Object.isFrozen(object), false);
  }
  assert.equal(
    Reflect.set(authenticated, "payload", { ...f.payload, decision: "deny" }),
    false,
  );
  assert.equal(Reflect.set(authenticated, "signature", {}), false);
  assert.equal(Reflect.set(authenticated.payload, "decision", "deny"), false);
  assert.equal(Reflect.set(authenticated.signature, "value", "corrupt"), false);
  assert.equal(
    Reflect.deleteProperty(authenticated.payload, "decision"),
    false,
  );
  assert.throws(
    () =>
      Object.defineProperty(authenticated.payload, "decision", {
        value: "deny",
      }),
    TypeError,
  );
  assert.throws(() => {
    // @ts-expect-error Authenticated payload fields are readonly as well as frozen.
    authenticated.payload.decision = "deny";
  }, TypeError);
  assert.throws(() => {
    // @ts-expect-error Authenticated signature fields are readonly as well as frozen.
    authenticated.signature.value = "corrupt";
  }, TypeError);
  assert.throws(() => {
    // @ts-expect-error Authenticated top-level fields are readonly as well as frozen.
    authenticated.payload = f.payload;
  }, TypeError);
  assert.deepEqual(authenticated, f.review);

  source.payload.decision = "deny";
  source.signature.value = "corrupt";
  source.payload = { ...f.payload, decision: "deny" };
  source.signature = { ...f.review.signature, value: "other" };
  assert.deepEqual(authenticated, f.review);
  assert.equal(f.accepts(authenticated), true);
  assert.equal(f.accepts(source), false);
  const second = f.authenticate(f.review);
  assert.ok(second);
  assert.notStrictEqual(authenticated, second);
  assert.notStrictEqual(authenticated.payload, second.payload);
  assert.notStrictEqual(authenticated.signature, second.signature);
});

test("authentication returns undefined on validation failures and hostile input exceptions", () => {
  const f = fixture();
  const throwing = {
    get payload() {
      throw new Error("untrusted accessor failure");
    },
    signature: f.review.signature,
  };
  const { proxy, revoke } = Proxy.revocable(f.review, {});
  revoke();
  for (const value of [
    null,
    {},
    { ...f.review, authenticated: true },
    { ...f.review, payload: { ...f.payload, decision: "deny" } },
    { ...f.review, signature: { ...f.review.signature, value: "invalid" } },
    signGitOperatorReview(
      { ...f.payload, effectDigest: sha256("wrong") },
      pair.privateKey,
    ),
    signGitOperatorReview(
      { ...f.payload, expiresAt: iso(-1) },
      pair.privateKey,
    ),
    throwing,
    proxy,
  ]) {
    assert.equal(f.authenticate(value), undefined);
    assert.equal(f.accepts(value), false);
  }
  const throwingTrust = {
    ...f.trust,
    get operators() {
      throw new Error("untrusted trust accessor failure");
    },
  };
  for (const trust of [
    null,
    { ...f.trust, operators: [] },
    { ...f.trust, operators: [{ ...f.operator, enabled: false }] },
    {
      ...f.trust,
      operators: [{ ...f.operator, keys: [{ ...f.key, enabled: false }] }],
    },
    { ...f.trust, operators: [{ ...f.operator, permissions: [] }] },
    throwingTrust,
  ]) {
    assert.equal(f.authenticate(f.review, trust), undefined);
    assert.equal(f.accepts(f.review, trust), false);
  }
  assert.equal(
    authenticateGitOperatorReview(
      f.review,
      { ...f.proposal, allowedPaths: ["tampered"] },
      f.authority,
      f.effectDigest,
      f.trust,
    ),
    undefined,
  );
  assert.equal(
    authenticateGitOperatorReview(
      f.review,
      f.proposal,
      { ...f.authority, actionId: sha256("wrong") },
      f.effectDigest,
      f.trust,
    ),
    undefined,
  );
  assert.equal(
    authenticateGitOperatorReview(
      f.review,
      f.proposal,
      f.authority,
      sha256("wrong"),
      f.trust,
    ),
    undefined,
  );
});

test("boolean verification preserves valid and invalid behavior without narrowing caller input", () => {
  const f = fixture();
  for (const review of [
    f.review,
    signGitOperatorReview({ ...f.payload, decision: "deny" }, pair.privateKey),
  ]) {
    const input: unknown = review;
    const authenticated = f.authenticate(input);
    assert.ok(authenticated);
    assert.equal(authenticated.payload.decision, review.payload.decision);
    const verified = verifyGitOperatorReview(
      input,
      f.proposal,
      f.authority,
      f.effectDigest,
      f.trust,
    );
    assert.equal(verified, true);
    assert.equal(typeof verified, "boolean");
    if (
      verifyGitOperatorReview(
        input,
        f.proposal,
        f.authority,
        f.effectDigest,
        f.trust,
      )
    ) {
      // @ts-expect-error Boolean verification must not narrow caller-owned unknown input.
      assert.strictEqual(input.payload, review.payload);
    }
  }
  assert.equal(
    f.accepts({ ...f.review, payload: { ...f.payload, decision: "deny" } }),
    false,
  );
});
