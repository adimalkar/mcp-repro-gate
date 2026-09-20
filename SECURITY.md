# Security policy

## Supported versions

ReproGate is pre-release software. Security fixes are applied to the latest commit on `main`; no released version is currently supported as a production security boundary.

## Reporting a vulnerability

Do not open a public issue for a suspected vulnerability.

Use [GitHub private vulnerability reporting](https://github.com/adimalkar/mcp-repro-gate/security/advisories/new). Include:

- the affected commit or version;
- a minimal reproduction or proof of concept;
- the expected and observed trust boundary;
- potential confidentiality, integrity, or availability impact;
- any suggested mitigation.

You should receive an acknowledgement within three business days. Please allow a reasonable coordinated-disclosure period before publishing details.

## Current security boundary

Phase 1 plans and binds actions but does not execute downstream tools. Its token replay protection is process-local. Review [the threat model](docs/THREAT_MODEL.md) for current guarantees and known gaps.
