import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export const MAX_GIT_OUTPUT_BYTES = 16 * 1024 * 1024;
const GIT_TIMEOUT_MS = 15_000;

function executeGit(
  args: string[],
  environment: NodeJS.ProcessEnv,
  input: Uint8Array | undefined,
  maxOutputBytes: number,
  quietConfigProbe = false,
): { stdout: Buffer; status: number } {
  // Git <2.45 fails closed rather than silently allowing promisor lazy fetch.
  const result = spawnSync(
    "git",
    ["--no-optional-locks", "--no-lazy-fetch", ...args],
    {
      input: input === undefined ? undefined : Buffer.from(input),
      encoding: null,
      timeout: GIT_TIMEOUT_MS,
      maxBuffer: maxOutputBytes,
      env: environment,
      windowsHide: true,
    },
  );
  const emptyProbe =
    quietConfigProbe &&
    result.status === 1 &&
    result.stdout.length === 0 &&
    result.stderr.length === 0;
  if (
    result.error ||
    result.signal ||
    typeof result.status !== "number" ||
    (result.status !== 0 && !emptyProbe) ||
    result.stdout.length > maxOutputBytes ||
    result.stderr.length > maxOutputBytes
  ) {
    // Do not expose unrestricted repository/patch/config diagnostics.
    throw new Error(
      `Git staging command failed: ${result.error ? "time or output bound exceeded, or spawn failed" : "nonzero command result"}`,
    );
  }
  return { stdout: result.stdout, status: result.status };
}

/** Internal concrete Git runner, not an execution/authorization extension point. */
export function runGit(
  args: string[],
  input?: Uint8Array,
  maxOutputBytes = MAX_GIT_OUTPUT_BYTES,
): Buffer {
  if (
    !Number.isSafeInteger(maxOutputBytes) ||
    maxOutputBytes < 1 ||
    maxOutputBytes > MAX_GIT_OUTPUT_BYTES
  ) {
    throw new Error("Invalid Git output bound");
  }
  const scratch = mkdtempSync(join(tmpdir(), "reprogate-git-runner-"));
  try {
    const hooks = join(scratch, "hooks");
    mkdirSync(hooks);
    const emptyConfig = join(scratch, "config");
    writeFileSync(emptyConfig, "", { flag: "wx", mode: 0o600 });
    const environment: NodeJS.ProcessEnv = Object.fromEntries(
      Object.entries(process.env).filter(
        ([name]) => !name.toUpperCase().startsWith("GIT_"),
      ),
    );
    // Environment-backed command scope survives the local upload-pack child.
    // A parent-only -c is insufficient for malicious global packObjectsHook.
    const config: [string, string][] = [
      ["core.hooksPath", hooks],
      // Newer Git also accepts config-based hooks outside core.hooksPath.
      ...[
        "reference-transaction",
        "post-index-change",
        "post-checkout",
        "pre-commit",
        "prepare-commit-msg",
        "commit-msg",
        "post-commit",
        "pre-auto-gc",
        "pre-push",
        "post-rewrite",
      ].map((event): [string, string] => [`hook.${event}.enabled`, "false"]),
      ["core.fsmonitor", "false"],
      ["core.alternateRefsCommand", ""],
      ["core.unsetenvvars", ""],
      ["trace2.normalTarget", "0"],
      ["trace2.perfTarget", "0"],
      ["trace2.eventTarget", "0"],
      ["core.attributesFile", emptyConfig],
      ["init.templateDir", hooks],
      ["uploadpack.packObjectsHook", ""],
      ["gc.auto", "0"],
      ["gc.autoPackLimit", "0"],
      ["maintenance.auto", "false"],
      ["protocol.allow", "never"],
      ["protocol.file.allow", "always"],
      ["diff.external", ""],
      ["diff.algorithm", "myers"],
      ["diff.indentHeuristic", "true"],
      ["diff.context", "3"],
      ["diff.noprefix", "false"],
      ["diff.mnemonicPrefix", "false"],
      ["diff.renames", "true"],
      ["core.quotePath", "true"],
    ];
    Object.assign(environment, {
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_CONFIG_SYSTEM: emptyConfig,
      GIT_CONFIG_GLOBAL: emptyConfig,
      GIT_CONFIG_COUNT: String(config.length),
      GIT_TEMPLATE_DIR: hooks,
      GIT_NO_REPLACE_OBJECTS: "1",
      GIT_NO_LAZY_FETCH: "1",
      GIT_TERMINAL_PROMPT: "0",
      GIT_OPTIONAL_LOCKS: "0",
      GIT_ATTR_NOSYSTEM: "1",
      // Only the validated absolute-local clone needs a transport. All other
      // commands, including promisor lazy fetches, must not invoke one.
      GIT_ALLOW_PROTOCOL: args[0] === "clone" ? "file" : "",
    });
    const installConfig = () => {
      environment.GIT_CONFIG_COUNT = String(config.length);
      config.forEach(([name, value], index) => {
        environment[`GIT_CONFIG_KEY_${String(index)}`] = name;
        environment[`GIT_CONFIG_VALUE_${String(index)}`] = value;
      });
    };
    installConfig();
    if (args[0] === "-C" && args[1] !== undefined) {
      // Status can execute filters; diff can execute named external/textconv
      // drivers independently of diff.external. Probe effective config names
      // only (including local includes), never command values. Command-scope
      // overrides also survive child Git through the environment above.
      const probe = executeGit(
        [
          "-C",
          args[1],
          "config",
          "--null",
          "--name-only",
          "--get-regexp",
          "^(filter\\..*\\.(clean|smudge|process|required)|diff\\..*\\.(command|textconv))$",
        ],
        // Match config keys bytewise: a UTF-8 locale's regexp can silently
        // omit invalid UTF-8 names before the fatal decoder sees them.
        { ...environment, LC_ALL: "C" },
        undefined,
        1024 * 1024,
        true,
      );
      if (probe.status === 0) {
        const output = new TextDecoder("utf-8", { fatal: true }).decode(
          probe.stdout,
        );
        if (!output.endsWith("\0"))
          throw new Error("Git driver configuration was malformed");
        const drivers = new Map<string, "filter" | "diff">();
        for (const name of output.slice(0, -1).split("\0")) {
          const filter =
            /^filter\.(.+)\.(?:clean|smudge|process|required)$/u.exec(name);
          const diff = /^diff\.(.+)\.(?:command|textconv)$/u.exec(name);
          const driver = (filter ?? diff)?.[1];
          if (
            !driver ||
            Buffer.byteLength(driver) > 256 ||
            Array.from(driver).some((c) => {
              const code = c.charCodeAt(0);
              return code < 0x20 || code === 0x7f;
            })
          )
            throw new Error("Git driver configuration was malformed");
          const namespace = filter ? "filter" : "diff";
          drivers.set(`${namespace}.${driver}`, namespace);
          // Bound the combined driver count, not each callback field/key.
          // At most 128 * 4 additional command-scope config entries result.
          if (drivers.size > 128)
            throw new Error("Git driver configuration exceeds its bound");
        }
        for (const [prefix, namespace] of drivers) {
          if (namespace === "filter") {
            for (const field of ["clean", "smudge", "process"])
              config.push([`${prefix}.${field}`, ""]);
            config.push([`${prefix}.required`, "false"]);
          } else {
            // Empty command overrides fail closed if Git tries to use a named
            // driver, even with explicit --textconv. Existing staged diffs use
            // --no-ext-diff/--no-textconv and retain their exact raw bytes.
            config.push([`${prefix}.command`, ""], [`${prefix}.textconv`, ""]);
          }
        }
        installConfig();
      }
      if (args[2] === "status") {
        // Git recursively starts status in submodules with their own local
        // filter configuration. This slice does not attest that nested config;
        // reject gitlink workspaces before any recursive command can execute.
        const index = executeGit(
          ["-C", args[1], "ls-files", "--stage", "-z"],
          environment,
          undefined,
          MAX_GIT_OUTPUT_BYTES,
        ).stdout;
        if (
          index
            .toString("latin1")
            .split("\0")
            .some((record) => record.startsWith("160000 "))
        ) {
          throw new Error("Git workspace contains unsupported submodules");
        }
      }
    }
    return executeGit(args, environment, input, maxOutputBytes).stdout;
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

export function runGitLine(
  args: string[],
  input?: Uint8Array,
  maxOutputBytes?: number,
): string {
  const output = runGit(args, input, maxOutputBytes).toString("ascii");
  if (!output.endsWith("\n") || output.slice(0, -1).includes("\n")) {
    throw new Error("Git returned an unexpected single-line value");
  }
  return output.slice(0, -1);
}
