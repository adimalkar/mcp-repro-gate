import assert from "node:assert/strict";
import test from "node:test";

import { ACCEPTED, advisories, decide, devOnly } from "../scripts/audit.js";

const report = {
  auditReportVersion: 2,
  vulnerabilities: {
    picomatch: {
      severity: "high",
      via: [
        {
          source: 1,
          name: "picomatch",
          severity: "high",
          title: "picomatch vulnerable to ReDoS",
          url: "https://github.com/advisories/GHSA-fc5q-39xc-vjpf",
          range: "<=4.0.7",
        },
      ],
    },
    tinyglobby: { severity: "high", via: ["picomatch"] },
    "left-pad": {
      severity: "critical",
      via: [
        {
          source: 2,
          name: "left-pad",
          severity: "critical",
          title: "something bad",
          url: "https://github.com/advisories/GHSA-aaaa-bbbb-cccc",
        },
      ],
    },
    "low-thing": {
      severity: "moderate",
      via: [
        {
          source: 3,
          name: "low-thing",
          severity: "moderate",
          title: "minor",
          url: "https://github.com/advisories/GHSA-dddd-eeee-ffff",
        },
      ],
    },
  },
};
const lockfile = (dev: boolean) => ({
  packages: {
    "": {},
    "node_modules/picomatch": { dev: true },
    "node_modules/tinyglobby/node_modules/picomatch": { dev },
  },
});
const accepted = [
  {
    id: "GHSA-fc5q-39xc-vjpf",
    package: "picomatch",
    until: "2026-12-31",
    reason: "",
  },
];

test("only root advisories are reported, once each", () => {
  assert.deepEqual(
    advisories(report).map((advisory) => advisory.id),
    ["GHSA-fc5q-39xc-vjpf", "GHSA-aaaa-bbbb-cccc", "GHSA-dddd-eeee-ffff"],
  );
  assert.throws(() => advisories({}), /Unexpected npm audit report/u);
});

test("an accepted dev-only advisory passes until it expires; anything else high blocks", () => {
  const found = advisories(report);
  const inTime = decide(found, accepted, lockfile(true), "2026-12-31");
  assert.deepEqual(
    inTime.accepted.map((advisory) => advisory.id),
    ["GHSA-fc5q-39xc-vjpf"],
  );
  // Moderate advisories never block, as with --audit-level=high.
  assert.deepEqual(
    inTime.blocking.map((advisory) => [advisory.id, advisory.why]),
    [["GHSA-aaaa-bbbb-cccc", "not accepted"]],
  );
  const late = decide(found, accepted, lockfile(true), "2027-01-01");
  assert.deepEqual(
    late.blocking.map((advisory) => advisory.why),
    ["exception expired on 2026-12-31", "not accepted"],
  );
  const shipped = decide(found, accepted, lockfile(false), "2026-12-01");
  assert.equal(shipped.blocking[0]?.why, "no longer a dev-only dependency");
  // The same ID on another package is not covered.
  const other = decide(
    found,
    [{ ...accepted[0], package: "minimatch" } as (typeof accepted)[number]],
    lockfile(true),
    "2026-12-01",
  );
  assert.equal(other.blocking[0]?.why, "not accepted");
});

test("dev-only means every installed copy", () => {
  assert.equal(devOnly(lockfile(true), "picomatch"), true);
  assert.equal(devOnly(lockfile(false), "picomatch"), false);
  assert.equal(devOnly(lockfile(true), "absent"), false);
  assert.equal(devOnly({}, "picomatch"), false);
});

test("every accepted advisory says why and has a valid expiry", () => {
  for (const entry of ACCEPTED) {
    assert.match(entry.id, /^GHSA(?:-[0-9a-z]{4}){3}$/u);
    assert.match(entry.until, /^\d{4}-\d{2}-\d{2}$/u);
    assert.equal(
      new Date(`${entry.until}T00:00:00Z`).toISOString().slice(0, 10),
      entry.until,
    );
    assert.ok(entry.reason.length > 40);
  }
});
