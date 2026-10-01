# Out-of-band Git operator review

This workflow authenticates a configured operator key's decision about one exact staged Git effect. It does not promote a Git ref, prove human presence or actual inspection, or confine an agent process. The default MCP server exposes no Git approval/signing tool.

## Deployment roles and prerequisites

- The trusted host owns the repository configuration, catalog, policy, persisted plans and approval database. The agent must not be able to replace these inputs or write the approval ledger.
- The operator/signing service owns a protected Ed25519 private-key file outside the repository and outside the agent's access. On POSIX, the CLI requires current-user ownership and no group/other permissions; Windows deployments must enforce equivalent ACLs themselves. Symlinked or hard-linked signing files are rejected.
- The host first creates a `GitChangeIntentV1`, passes it as the exact arguments to `ReproGateKernel.plan`, persists that plan, and creates the proposal using its action ID/policy digest. The review CLI consumes that existing plan/proposal; it is not a new planning or automatic approval service. See [persisted-plan binding](GIT_CHANGE_PROPOSAL.md#bind-a-git-proposal-to-a-persisted-plan).
- Keep plan/approval databases and their SQLite sidecars outside the protected worktree and Git metadata directories. State aliases through symlinks or hard links are rejected. The plan database must already exist; import can create the approval database, while check/revoke require an existing ledger.

Build with `npm run build`. The examples below assume you run from the repository root and that trusted files have already been provisioned. Paths and identifiers in the configuration template are placeholders, not generated credentials.

## Host configuration

Git Review Configuration v1 is separate from Phase 2 execution configuration. It needs no downstream backend, filesystem observer or HMAC secret. Its strict [schema](../schemas/git-review-config.schema.json) references the public trust shape in [Git Operator Review v1](../schemas/git-operator-review.schema.json).

```json
{
  "configVersion": 1,
  "repositoryPath": "/workspace/example-repository",
  "repositoryId": "example/repository",
  "destinationRef": "refs/heads/main",
  "planDatabasePath": "/trusted/reprogate/plans.sqlite",
  "approvalDatabasePath": "/trusted/reprogate/git-approvals.sqlite",
  "catalogTool": {
    "toolRef": "git.change",
    "serverRef": "reprogate.git",
    "toolName": "promote_patch",
    "description": "Plan an exact Git change",
    "inputSchema": { "type": "object" },
    "effects": ["local_write"],
    "scopes": ["git_change:promote"]
  },
  "currentPolicy": {
    "version": 1,
    "defaults": {
      "local_read": "allow",
      "local_write": "approval_required",
      "process_exec": "deny",
      "network_read": "deny",
      "network_write": "deny",
      "credential_use": "deny",
      "destructive": "deny"
    },
    "rules": []
  },
  "trust": {
    "audience": "reprogate:example-deployment",
    "maxReviewTtlMs": 900000,
    "operators": [
      {
        "operatorId": "alice",
        "enabled": true,
        "keys": [
          {
            "keyId": "<SHA-256 fingerprint of public Ed25519 SPKI DER>",
            "publicKeyPem": "<public Ed25519 SPKI PEM, never a private key>",
            "enabled": true
          }
        ],
        "permissions": [
          {
            "repositoryId": "example/repository",
            "workspaceRootDigest": "<observed worktree-root SHA-256 digest>",
            "destinationRef": "refs/heads/main"
          }
        ]
      }
    ]
  }
}
```

Replace both digest placeholders with actual `sha256:` plus 64 lowercase hexadecimal digits. Compute `keyId` with `gitOperatorKeyId(createPublicKey(publicKeyPem))`, not by hashing PEM text. Obtain the root digest from the host's `observeCleanGitWorkspace` witness. Catalog/policy values must match the persisted plan. Permissions are exact repository/root/ref tuples, not globs. Operator/key enabled flags are required; ambiguous declarations and private trust keys are rejected. Use an audience specific to the trust deployment, not a shared default across unrelated ledgers.

Every operation validates configuration and observes its canonical digest at freshness boundaries. A changed catalog, policy, trust declaration or database location invalidates that operation. These checks are not a filesystem reservation against a hostile same-host process.

## Prepare and sign

```bash
node dist/src/cli.js git-review prepare \
  --config /trusted/reprogate/git-review.json \
  --proposal /trusted/reprogate/requests/proposal.json \
  --patch /trusted/reprogate/requests/change.patch \
  > /trusted/reprogate/requests/request.json
```

Prepare returns only deterministic request metadata: proposal, derived authority, staged manifest and digests. It derives authority before and after isolated staging. The patch bytes and transient computed diff are not written into that request or the approval database.

The signer must select an explicit decision and canonical UTC expiry within the proposal, plan and configured maximum review TTL. For example, derive a five-minute expiry on the trusted signing host:

```bash
REVIEW_EXPIRY=$(node -e 'process.stdout.write(new Date(Date.now() + 5 * 60 * 1000).toISOString())')
node dist/src/cli.js git-review sign \
  --config /trusted/reprogate/git-review.json \
  --proposal /trusted/reprogate/requests/proposal.json \
  --patch /trusted/reprogate/requests/change.patch \
  --request /trusted/reprogate/requests/request.json \
  --operator alice \
  --key-file /trusted/operator/review-key.pem \
  --decision approve \
  --expires-at "$REVIEW_EXPIRY" \
  > /trusted/reprogate/requests/review.json
```

`deny` is equally explicit and signed. There is no default approval. The CLI regenerates and compares the complete prepared request, shows repository/ref/base/candidate/paths/digests/expiry and the full Git-generated diff on stderr, then loads the private key. No Git subprocess runs after the key is loaded. Private key bytes are never supplied through arguments or environment variables, returned in JSON, or stored in the ledger. The file path itself is an argument, not signing material.

The diff is clearly delimited as untrusted content. Each line is prefixed, terminal controls/bidi/invisible characters are escaped, and invalid UTF-8 bytes are represented losslessly rather than replaced. Output is not silently truncated. The display is not a secret scanner: source changes may themselves contain secrets, and explicitly redirecting stderr will retain the review display.

An automated service possessing an authorized key can use this command. A signature authenticates key possession and an exact decision, not a human review ceremony.

## Import, check and revoke

```bash
node dist/src/cli.js git-review import \
  --config /trusted/reprogate/git-review.json \
  --proposal /trusted/reprogate/requests/proposal.json \
  --patch /trusted/reprogate/requests/change.patch \
  --review /trusted/reprogate/requests/review.json

node dist/src/cli.js git-review check \
  --config /trusted/reprogate/git-review.json \
  --proposal /trusted/reprogate/requests/proposal.json \
  --patch /trusted/reprogate/requests/change.patch \
  --approval-id '<approval UUID returned by import>'

node dist/src/cli.js git-review revoke \
  --config /trusted/reprogate/git-review.json \
  --approval-id '<approval UUID returned by import>'
```

Approve returns a decision/review digest and approval object; deny returns a decision/review digest without an approval. Approval plus signed evidence is inserted atomically. A denial creates a permanent per-proposal tombstone. First accepted decision wins in that database, and an existing legacy/revoked approval cannot be retroactively authenticated. Repeated/conflicting imports fail. Renewals require a new proposal and fresh signed decision. Deny is an initial refusal, not a signed revocation command.

Check loads linked proof from the ledger and revalidates exact bindings, current plan/policy/catalog/workspace, key permissions, expiry and revocation around fresh staging. Legacy grants without linked signed proof cannot pass. Revocation is a trusted-host ledger operation; it needs no patch/proposal/key or clean worktree/current ref. The configured repository directory must still exist for state-location validation.

## Output, limits and compatibility

- JSON results are a single canonical line on stdout, with non-ASCII characters escaped. Signing display and errors go to stderr. Node 22 may also emit its SQLite experimental warning there.
- Exit 0 means success or a true check/revoke result; exit 1 means an error or `{"valid":false}`/`{"revoked":false}`; exit 2 means a usage error. `git-review --help` prints usage with exit 0.
- Every listed option is required exactly once as `--name value`. Unknown, duplicate, positional and `--name=value` arguments are rejected. Approval IDs must be lowercase UUIDs. `--config` must be absolute; other input paths resolve against the current working directory.
- Reads are bounded during the read, from regular-file descriptors: configuration 1 MiB, patch/proposal 4 MiB, prepared request 8 MiB, signed review 64 KiB and key file 16 KiB. JSON must be valid UTF-8. Private-key parse/read failures do not echo supplied material.
- The old Phase 2 `approve` and `verify-receipt` commands remain separate HMAC-based host primitives. Existing Git proposal/staging/approval contracts remain compatible; authenticated checks intentionally reject legacy grants without signed evidence.
- No operation updates protected HEAD, index, worktree or ref. A successful check is repeatable and neither consumes nor reserves authorization. Atomic compare-and-swap promotion, revocation serialization at that boundary, crash recovery and portable promotion receipt bundles remain future work.

See [Git contracts](GIT_CHANGE_PROPOSAL.md), the [threat model](THREAT_MODEL.md), and the [roadmap](ROADMAP.md).
