import assert from "node:assert/strict";
import {
  chmodSync,
  mkdtempSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { SqliteExecutionStore } from "../src/execution-store.js";
import { SqliteGitApprovalStore } from "../src/git-approval-store.js";

const posix = process.platform !== "win32";

test(
  "new plan and approval databases and their sidecars are owner-only",
  { skip: !posix },
  (t) => {
    const directory = mkdtempSync(join(tmpdir(), "reprogate-private-db-"));
    t.after(() => {
      rmSync(directory, { recursive: true, force: true });
    });
    const plans = new SqliteExecutionStore(join(directory, "plans.sqlite"));
    const approvals = new SqliteGitApprovalStore(
      join(directory, "approvals.sqlite"),
    );
    try {
      for (const name of ["plans.sqlite", "approvals.sqlite"])
        for (const suffix of ["", "-wal", "-shm"]) {
          const mode = statSync(join(directory, name + suffix)).mode & 0o777;
          assert.equal(mode, 0o600, `${name}${suffix} is ${mode.toString(8)}`);
        }
    } finally {
      plans.close();
      approvals.close();
    }
  },
);

test("an existing database keeps its own mode", { skip: !posix }, (t) => {
  const directory = mkdtempSync(join(tmpdir(), "reprogate-private-db-"));
  t.after(() => {
    rmSync(directory, { recursive: true, force: true });
  });
  const path = join(directory, "shared.sqlite");
  writeFileSync(path, "");
  chmodSync(path, 0o640);
  new SqliteExecutionStore(path).close();
  assert.equal(statSync(path).mode & 0o777, 0o640);
});
