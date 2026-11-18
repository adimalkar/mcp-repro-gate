/**
 * `npm audit --audit-level=high`, with a short list of accepted advisories.
 * An accepted advisory still fails the audit once it expires, or when the
 * package is no longer dev-only. Every other high or critical advisory fails
 * as before.
 *
 *   npm run audit:check
 */
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

export interface AcceptedAdvisory {
  id: string;
  package: string;
  /** Last day the exception applies (UTC), as YYYY-MM-DD. */
  until: string;
  reason: string;
}

export const ACCEPTED: readonly AcceptedAdvisory[] = [
  {
    id: "GHSA-fc5q-39xc-vjpf",
    package: "picomatch",
    until: "2026-12-31",
    reason:
      "ReDoS through repeated extglobs; no patched release exists (all <= 4.0.7). Reached only through typescript-eslint -> tinyglobby for linting, with glob patterns from this repository's own configuration. Remove when a fixed picomatch ships.",
  },
];

const BLOCKING = new Set(["high", "critical"]);

export interface Advisory {
  id: string;
  package: string;
  severity: string;
  title: string;
}

/** Root advisories in an `npm audit --json` report (version 2). */
export function advisories(report: unknown): Advisory[] {
  const vulnerabilities = (report as { vulnerabilities?: unknown })
    .vulnerabilities;
  if (vulnerabilities === null || typeof vulnerabilities !== "object")
    throw new Error("Unexpected npm audit report");
  const found = new Map<string, Advisory>();
  for (const entry of Object.values(
    vulnerabilities as Record<string, unknown>,
  )) {
    const via = (entry as { via?: unknown }).via;
    if (!Array.isArray(via)) throw new Error("Unexpected npm audit report");
    for (const item of via) {
      // A string names another vulnerable package, reported on its own.
      if (typeof item === "string") continue;
      const { url, name, severity, title } = item as Record<string, unknown>;
      const id =
        typeof url === "string"
          ? /GHSA(?:-[0-9a-z]{4}){3}/iu.exec(url)?.[0]
          : undefined;
      if (typeof name !== "string" || typeof severity !== "string")
        throw new Error("Unexpected npm audit report");
      const key = id ?? `${name}:${String(title)}`;
      found.set(key, {
        id: id ?? key,
        package: name,
        severity,
        title: typeof title === "string" ? title : "",
      });
    }
  }
  return [...found.values()];
}

/** Is every installed copy of `name` a development dependency? */
export function devOnly(lockfile: unknown, name: string): boolean {
  const packages = (
    lockfile as { packages?: Record<string, { dev?: boolean }> }
  ).packages;
  if (packages === undefined) return false;
  const copies = Object.entries(packages).filter(
    ([path]) =>
      path === `node_modules/${name}` || path.endsWith(`/node_modules/${name}`),
  );
  return copies.length > 0 && copies.every(([, entry]) => entry.dev === true);
}

export interface AuditDecision {
  blocking: (Advisory & { why: string })[];
  accepted: (Advisory & { until: string })[];
}

export function decide(
  found: readonly Advisory[],
  accepted: readonly AcceptedAdvisory[],
  lockfile: unknown,
  today: string,
): AuditDecision {
  const decision: AuditDecision = { blocking: [], accepted: [] };
  for (const advisory of found) {
    if (!BLOCKING.has(advisory.severity)) continue;
    const exception = accepted.find(
      (entry) => entry.id === advisory.id && entry.package === advisory.package,
    );
    if (exception === undefined)
      decision.blocking.push({ ...advisory, why: "not accepted" });
    else if (today > exception.until)
      decision.blocking.push({
        ...advisory,
        why: `exception expired on ${exception.until}`,
      });
    else if (!devOnly(lockfile, advisory.package))
      decision.blocking.push({
        ...advisory,
        why: "no longer a dev-only dependency",
      });
    else decision.accepted.push({ ...advisory, until: exception.until });
  }
  return decision;
}

function main(): void {
  const run = spawnSync("npm", ["audit", "--json"], { encoding: "utf8" });
  let report: unknown;
  try {
    report = JSON.parse(run.stdout);
  } catch {
    process.stderr.write(`npm audit gave no report:\n${run.stderr}`);
    process.exitCode = 1;
    return;
  }
  if ((report as { error?: unknown }).error !== undefined) {
    process.stderr.write(
      `npm audit failed: ${JSON.stringify((report as { error: unknown }).error)}\n`,
    );
    process.exitCode = 1;
    return;
  }
  const lockfile = JSON.parse(
    readFileSync("package-lock.json", "utf8"),
  ) as unknown;
  const decision = decide(
    advisories(report),
    ACCEPTED,
    lockfile,
    new Date().toISOString().slice(0, 10),
  );
  for (const advisory of decision.accepted)
    process.stdout.write(
      `accepted until ${advisory.until}: ${advisory.id} ${advisory.package} (${advisory.severity}) ${advisory.title}\n`,
    );
  for (const advisory of decision.blocking)
    process.stderr.write(
      `blocking: ${advisory.id} ${advisory.package} (${advisory.severity}) ${advisory.title}: ${advisory.why}\n`,
    );
  if (decision.blocking.length > 0) process.exitCode = 1;
  else
    process.stdout.write(
      "No high or critical advisories outside the accepted list.\n",
    );
}

if (
  process.argv[1] !== undefined &&
  pathToFileURL(resolve(process.argv[1])).href === import.meta.url
)
  main();
