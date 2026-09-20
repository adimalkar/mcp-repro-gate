# Contributing to ReproGate

Thank you for helping make agent tool execution more accountable and reproducible.

## Before starting

- Read the [project scope](README.md), [roadmap](docs/ROADMAP.md), and [threat model](docs/THREAT_MODEL.md).
- For a substantial feature or protocol change, open a feature proposal before implementation.
- Report vulnerabilities privately according to [SECURITY.md](SECURITY.md).

## Development setup

ReproGate requires Node.js 22.13 or newer. Node.js 24 LTS is recommended.

```bash
npm ci
npm run check
npm run demo
```

Useful individual commands:

```bash
npm run format
npm run lint
npm run typecheck
npm test
npm run pack:check
```

## Pull requests

Keep pull requests focused and include tests for behavior changes. CI must pass on supported Node.js versions and operating systems.

A change that increases authority, retained data, network or filesystem access, automatic side effects, or secret handling must update `docs/THREAT_MODEL.md` in the same pull request. Changes to a public contract must update its schema and compatibility documentation.

ReproGate uses an Apache-2.0 license. By submitting a contribution, you agree that your contribution is licensed under the same terms.
