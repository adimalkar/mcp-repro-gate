# Portable promotion evidence and an offline verifier

Status: proposed implementation. This is Phase 3 slice 3 ("portable evidence") of the [roadmap](../ROADMAP.md). It stacks on the promotion gate (#46), the promotion CLI (#47) and the end-to-end fixes (#48). Today a promotion's evidence lives only in the host's SQLite ledger:

- the operator's signed review;
- the attempt, admission and outcome rows;
- the proposal and its patch digest.

Anyone checking it later must trust the host's database and, for execution receipts, share the host's HMAC secret.

## Goal

Export one promotion as a self-contained, content-addressed bundle. A third party can then verify it offline with public keys only:

- **Authorization:** the change was approved by an enabled operator key, for this exact proposal, authority and effect, and the approval was valid **at the admission time** the host recorded.
- **Host attestation:** the host's ledger admitted the attempt with that approval unrevoked, and then recorded this outcome.
- **Tamper evidence:** any change to any part of the bundle is detected.
- **Effect check:** with a trusted local clone, the verifier recomputes the Git effect the operator signed. The candidate commit's parent is the expected old commit, its tree is the staged candidate tree, and the diff Git produces between them hashes to the staged patch digest. That diff covers every path, mode and change kind.

## Deliverable

### Bundle format v1 (`schemas/git-promotion-evidence.schema.json`)

```text
{
  bundleVersion: 1,
  manifest: {
    attemptId, repositoryId, destinationRef,
    proposal,            // the version 2 proposal, verbatim
    review,              // the signed operator review, verbatim
    attempt,             // strict readback, without host paths or fence details
    admission, outcome,  // verbatim ledger records
    coverage,            // what was enforced, observed or not covered
    exportedAt,
    hostKeyId            // SPKI SHA-256 digest of the host evidence key
  },
  manifestDigest,        // sha256 of the canonical JSON of manifest
  signature: { algorithm: "ed25519", value }  // over a domain-separated manifestDigest
}
```

- **Content addressing:** the bundle is addressed by `manifestDigest`. Each embedded record keeps its own digest from the ledger, such as `reviewDigest`, `authorityDigest`, `effectDigest` and the admission's bindings, so the verifier checks the internal links too. `effectDigest` is the digest of the attempt's `prepared.staged` record (base commit, candidate tree, changed paths, staged patch digest), which is what the operator signed.
- **No raw source by default:** the proposal carries the patch digest and path list, not patch text. The patch is supplied separately when the effect check needs it.
- **Coverage statement:** fixed for this backend:
  - the Git ref transition is `enforced` (compare-and-swap at the gate);
  - candidate objects are `observed`;
  - filesystem, process, network and credential effects are `not_covered`.

  This is the roadmap's requirement that a Git-ref-scoped result never implies uncovered effects were verified.

- **Host paths kept out:** `repositoryPath`, the fence path and database paths are omitted, because they are host details, not evidence.

### Host evidence key

A version 2 configuration may add `evidence: { signingKeyPath }`, an Ed25519 private key. It follows the same rules as operator keys:

- protected file checks;
- the SPKI digest as the key ID;
- it must not be an operator key.

The host signs only at export, and only facts already in its ledger. The signature attests "this host's ledger recorded these records". It is not an independent witness: a compromised host can sign a false admission. The threat model will say so.

### Commands

```bash
node dist/src/cli.js git-review evidence export --config /trusted/review.json --attempt-id <id> > bundle.json
node dist/src/cli.js verify-evidence --bundle bundle.json --trust trust.json [--repo /clone] [--patch change.patch]
```

- **Export prerequisites:** `export` requires a terminal outcome. A `prepared` or admitted attempt with no outcome is refused, so a bundle never describes an attempt still in flight.
- **Trust input:** `verify-evidence` needs no host configuration, databases or secrets. `trust.json` lists the accepted host evidence key IDs and public keys, plus the operator trust block, in the same shape as the configuration's `trust`. The audience and the destination permissions are checked against it.
- **Result:** the verifier prints one JSON report with a `result` and per-check details:
  - `verified`: every check passed, including the effect check if `--repo` or `--patch` was given;
  - `failed`: a signature, digest, link, permission or time check failed, or the effect did not match;
  - `indeterminate`: the outcome is `indeterminate` or `failed`, so no ref transition is claimed; signatures are still checked;
  - `unchecked_effect`: the authorization and attestation checks passed, but no repository or patch was supplied.

  Exit code 0 only for `verified`. `drifted` is reserved for a later live-ref check, because a destination that moved after promotion is not evidence against it.

### Verifier checks

1. **Bundle integrity:** strict schema; `manifestDigest` recomputed; the host signature checked against an accepted host key.
2. **Operator review:** the signature is checked under the trust block. Then:
   - the audience, operator, key and destination permission match the bundle's repository and ref;
   - `issuedAt <= admittedAt < expiresAt`;
   - the decision is `approve`.
3. **Links:** the review's `proposalId`, `authorityDigest` and `effectDigest` equal the attempt's, and `effectDigest` is recomputed from `prepared.staged`. The staged record's proposal ID and base commit match the proposal. The admission's `reviewDigest` and `authorityDigest` equal the attempt's. The outcome's `attemptId` and state are consistent with the admission. `confirmed` requires `observedDestinationOid` to equal `candidateCommitOid`.
4. **Effect, with `--repo`:** the verifier reads objects only, from a clone the verifier trusts, never a working tree, through the existing hardened Git runner.
   - `candidateCommitOid` exists, has exactly one parent, and that parent is `expectedOldOid`.
   - Its tree is `staged.candidateTreeOid`.
   - The diff between the two trees, produced with the same Git options the staging step uses, hashes to `staged.stagedPatchDigest`. Its changed paths equal `staged.changedPaths` and lie within the proposal's `allowedPaths`.
5. **Effect, with `--patch`:** the patch's digest equals the proposal's `patchDigest`. With `--repo` as well, the patch is applied to the base commit in a disposable index, reusing the staging code, and must reproduce `staged.candidateTreeOid`. With `--patch` alone, only the digest is checked, and the report says so.

## Compatibility

- **Configuration:** new and optional. Version 1 configurations and version 2 configurations without `evidence` behave exactly as before.
- **Existing ledger rows:** the bundle embeds them verbatim. No schema version changes.
- **HMAC receipts:** execution receipts keep HMAC. Asymmetric receipts for Phase 2 executions are out of scope.

## Verification

- **Round trip:** a confirmed promotion in a temporary repository is exported, then verified as `verified` with `--repo`, and as `unchecked_effect` without it.
- **Tamper tests:** every manifest field and each embedded record is altered once: one byte, a reordered key, a swapped digest. Each must fail with the right check named. Also covered:
  - a wrong host key, a disabled operator key, an expired review, or a review for another ref;
  - a `failed` or `indeterminate` outcome;
  - a candidate commit with an extra path, a changed mode, or a different parent, in a real repository.
- **Export refusals:** an attempt still in flight, and a host key that is also an operator key.
- **Offline:** the verifier runs with no configuration file, database or environment secret.
- **Mutation:** removing each verifier check fails a test.
- **Docs:** `docs/GIT_PROMOTION.md` gets an evidence section, the threat model gets an evidence boundary entry, and the CHANGELOG is updated.

## Out of scope

- Measuring false denials on benign fixtures and the adversarial fixture corpus. That is the remaining Phase 3 exit criterion and comes next.
- Test and secret-scan verifier outputs inside the bundle.
- Live-ref drift checks.
- Transparency logs or third-party timestamping.

## Implementation notes

- **Commands:** they are `git-review export-evidence` and `git-review verify-evidence`, beside the other `git-review` commands. `verify-evidence` still reads no configuration.
- **Proposal source:** the bundle has no separate `proposal`. The attempt already embeds it, so the verifier checks it there.
- **Attempt record:** the attempt is exported without `repositoryPath` and `fenceOwner`, because the fence owner carries the fence token. `parseGitPromotionAttemptEvidence` applies the same proposal, prepared-object and authority checks as the journal parser. `parseGitPromotionRecords` shares the admission and outcome binding checks with the journal readback.
- **Review time:** `authenticateGitOperatorReview` gained an optional reference time, so the review is judged at admission, or at reservation for an attempt that was never admitted. The default is still the current time.
- **Staged diff equivalence:** the verifier reproduces staging's computation exactly: it reads the candidate tree into an index (re-hashing it with `write-tree`), then hashes `git diff --cached --binary --no-ext-diff --no-textconv <base>`. It does this in an empty repository that borrows the trusted clone's objects, with commit-graph caches disabled.

## Review

The first independent review found no HIGH issues and requested changes.

- **Medium (fixed): CLI options.** `OPTIONAL` was global, so `--patch` became optional for every command. Options are now optional per command, only for `verify-evidence`, and there is a test.
- **Medium (fixed): fetched clones and attributes.** The effect checks cloned the trusted repository, which misses objects reachable only from remote refs. They also ran `git diff` in that clone, where worktree attributes and repository configuration can change the bytes. Fix: they now run in an empty disposable repository that borrows the clone's objects through alternates, and the staged diff is computed exactly as staging computes it (`read-tree` of the candidate, then `diff --cached`).
- **Medium (fixed): tests.** New tests cover:
  - verifying after the review expired;
  - a reservation or admission backdated before the review;
  - deny and short-lived reviews re-signed by the operator key;
  - candidate commits with a wrong parent, two parents, wrong metadata, or a tag OID;
  - a forged tree that the patch does not reproduce;
  - a fetched clone;
  - non-canonical signatures, prototype keys, and private-key PEMs.

  Every verifier check now fails a test when removed.

- **Low (fixed):**
  - the digest covers the manifest exactly as received, and prototype keys are rejected;
  - signatures must be canonical base64url;
  - host keys must be public-key PEMs;
  - the candidate commit is re-hashed against its OID;
  - the review is authenticated at reservation as well as admission;
  - the admission deadline must fall within the review's validity;
  - a `failed` outcome reports `not_promoted`;
  - the docs say what `verified` does not cover.
- **Corrections to the plan above:**
  - `--patch` alone gives `unchecked_effect`, not `verified`;
  - changed paths are covered by the staged diff digest, not recomputed separately;
  - the patch check re-runs staging's `read-tree`/`apply --cached`/`write-tree` in the borrowed-object repository rather than calling the staging code;
  - a "reordered key" is not a tamper case under canonical JSON.
