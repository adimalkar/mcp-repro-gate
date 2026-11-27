import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { test, type TestContext } from "node:test";
import { fileURLToPath } from "node:url";
import {
  createReportWriter,
  measure,
  pinnedDefinition,
  runTrials,
  trialSchedule,
  type Trial,
} from "../benchmarks/two-host.js";
import {
  wireCallFailed,
  wireSampleSchema,
} from "../benchmarks/two-host-wire.js";

function scratch(t: TestContext) {
  const path = mkdtempSync(join(tmpdir(), "reprogate-two-host-test-"));
  t.after(() => {
    rmSync(path, {
      recursive: true,
      force: true,
      maxRetries: 10,
      retryDelay: 100,
    });
  });
  return path;
}
const source = [
  "export function canonicalJson(input: unknown) {",
  "  if (input) {",
  "    const keys = Object.keys(record).sort();",
  "    return keys;",
  "  }",
  "  return [];",
  "}",
].join("\n");
const privateMarker = "discard-this-host-output";
const stubHost = `
const fs = require("node:fs");
const env=process.env;
const answer = JSON.stringify({path: "src/canonical-json.ts", source: env.FIXTURE_SOURCE});
const answerEvent = {type: "item.completed", item: {type: "agent_message", text: answer}};
const calls = ["search_graph", "get_code_snippet"].map(name => ({
  method:"tools/call", bytes:37, error:false,
  ...(env.FIXTURE_SURFACE==="direct" ? {tool:name} : {tool:"action.run",graphTool:name}),
}));
fs.appendFileSync("wire.jsonl", calls.map(x=>JSON.stringify(x)).join("\\n")+"\\n");
if (env.FIXTURE_HOST === "codex") {
  console.log(JSON.stringify(answerEvent));
  console.log(JSON.stringify({type:"turn.completed",usage:{input_tokens:7}}));
} else {
  console.log(JSON.stringify({type:"result",is_error:false,result:answer,usage:{input_tokens:9}}));
}
if(env.FIXTURE_MODE==="truncated") process.stdout.write('{"incomplete":"'+env.FIXTURE_PRIVATE);
if(env.FIXTURE_MODE==="exit") { console.error(env.FIXTURE_PRIVATE); process.exitCode=17; }
if(env.FIXTURE_MODE==="wire") fs.appendFileSync("wire.jsonl", JSON.stringify({...calls[0], tool:env.FIXTURE_PRIVATE})+"\\n" + '{"bytes"');
`;
function fixtureRun(cwd: string, trial: Trial, answer: string, mode = "ok") {
  return measure(
    trial,
    source,
    cwd,
    [],
    {
      ...process.env,
      FIXTURE_HOST: trial.host,
      FIXTURE_SURFACE: trial.surface,
      FIXTURE_SOURCE: answer,
      FIXTURE_MODE: mode,
      FIXTURE_PRIVATE: privateMarker,
    },
    (_host, _args, options) =>
      spawnSync(process.execPath, ["-e", stubHost], options),
  );
}
test("rubric v2 uses exactly one complete exported function from the fixture", (t) => {
  const dir = scratch(t);
  const [trial] = trialSchedule(1, "a", "b");
  assert.ok(trial);
  const file = join(dir, trial.task.file);
  mkdirSync(join(dir, "src"));
  writeFileSync(
    file,
    "/* leading documentation */\r\n" +
      source.replaceAll("\n", "\r\n") +
      "\r\nexport const neighbor = 1;\r\n",
  );
  assert.equal(pinnedDefinition(dir, trial.task), source);
  for (const [answer, correct] of [
    [source.replaceAll("\n", "\r\n") + "\r\n", true],
    [source.slice(0, source.indexOf("  return [];")), false],
    [source.replace("return keys;", "return record;"), false],
    [source + "\nexport const neighbor = 1;", false],
  ] as const) {
    const run = fixtureRun(mkdtempSync(join(dir, "run-")), trial, answer);
    assert.equal(run.answerCorrect, correct);
    assert.equal(run.pass, correct);
  }
  writeFileSync(file, source + "\n" + source);
  assert.throws(() => pinnedDefinition(dir, trial.task), /ambiguous/u);
});
test("the matrix checkpoints attempts, keeps sanitized failure rows and continues through the next host", (t) => {
  const dir = scratch(t);
  const plan = trialSchedule(1, "a", "b");
  const snapshots: string[][] = [];
  const modes = ["truncated", "exit", "wire", "ok"];
  let number = 0;
  const result = runTrials(
    plan,
    (trial) => {
      const mode = modes[number++];
      return fixtureRun(mkdtempSync(join(dir, "run-")), trial, source, mode);
    },
    () => {
      /* This fixture has no shared corpus. */
    },
    (rows) => {
      snapshots.push(rows.map((row) => row.state));
    },
  );
  assert.deepEqual(snapshots[0], Array(4).fill("unattempted"));
  assert.deepEqual(snapshots[1], [
    "started",
    "unattempted",
    "unattempted",
    "unattempted",
  ]);
  assert.deepEqual(snapshots.at(-1), ["failed", "failed", "failed", "passed"]);
  assert.deepEqual(
    result.map((r) => "failure" in r && r.failure),
    ["invalid_host_stream", "host_exit", "invalid_wire_stream", null],
  );
  assert.deepEqual(
    result.map((r) => ("status" in r ? r.status : null)),
    [0, 17, 0, 0],
  );
  assert.deepEqual(
    result.map((r) => "toolCallResponses" in r && r.toolCallResponses),
    [2, 2, 2, 2],
  );
  assert.ok(!JSON.stringify(result).includes(privateMarker));
  assert.ok(!JSON.stringify(result).includes("Object.keys"));
});
test("a changed corpus invalidates the current trial and leaves later trials unattempted", (t) => {
  const dir = scratch(t);
  let snapshot = "";
  assert.throws(
    () =>
      runTrials(
        trialSchedule(1, "a", "b"),
        (trial) => fixtureRun(dir, trial, source),
        () => {
          throw new Error(privateMarker);
        },
        (rows) => {
          snapshot = JSON.stringify(rows);
        },
      ),
    /Corpus verification failed/u,
  );
  assert.ok(!snapshot.includes(privateMarker));
  assert.deepEqual(
    (JSON.parse(snapshot) as { state: string }[]).map((r) => r.state),
    ["failed", "unattempted", "unattempted", "unattempted"],
  );
  const [invalid] = JSON.parse(snapshot) as {
    pass: boolean;
    failure: string;
    toolResultBytes: number;
    usage: { input_tokens: number };
  }[];
  assert.equal(invalid?.failure, "corpus_changed");
  assert.equal(invalid.pass, false);
  assert.equal(invalid.toolResultBytes, 74);
  assert.equal(invalid.usage.input_tokens, 7);
});

test("a timed-out host records a bounded failure", (t) => {
  const [trial] = trialSchedule(1, "a", "b");
  assert.ok(trial);
  const row = measure(
    trial,
    source,
    scratch(t),
    [],
    process.env,
    (_host, _args, options) => {
      assert.equal(options.killSignal, "SIGKILL");
      return spawnSync(
        process.execPath,
        ["-e", "process.on('SIGTERM', () => {}); setTimeout(() => {}, 2000)"],
        { ...options, timeout: 200 },
      );
    },
  );
  assert.equal(row.failure, "host_timeout");
  assert.equal(row.completed, false);
  assert.equal(row.pass, false);
});

test("the first benchmark checkpoint claims a fresh report and keeps concurrent writers out", (t) => {
  const path = join(scratch(t), "report.json");
  const owner = createReportWriter(path);
  const other = createReportWriter(path);
  owner({ state: "unattempted" });
  assert.throws(() => other({ state: "started" }), { code: "EEXIST" });
  assert.deepEqual(JSON.parse(readFileSync(path, "utf8")), {
    state: "unattempted",
  });
  writeFileSync(path + ".tmp", "unrelated");
  owner({ state: "passed" });
  assert.deepEqual(JSON.parse(readFileSync(path, "utf8")), { state: "passed" });
  assert.equal(readFileSync(path + ".tmp", "utf8"), "unrelated");
});

test("a graph setup failure leaves the report name available", (t) => {
  const dir = scratch(t);
  const report = join(dir, "result.json");
  const runner = fileURLToPath(
    new URL("../benchmarks/two-host.js", import.meta.url),
  );
  const result = spawnSync(process.execPath, [
    runner,
    join(dir, "missing-graph"),
    report,
    "a",
    "b",
    "1",
  ]);
  assert.notEqual(result.status, 0);
  assert.equal(existsSync(report), false);
});

test("the wire recorder counts graph application errors on both surfaces", () => {
  const direct = { tool: "search_graph" } as const;
  const facade = { tool: "action.run", graphTool: "search_graph" } as const;
  const issue = { error: "index unavailable" };
  const text = [{ type: "text", text: JSON.stringify(issue) }];
  assert.equal(
    wireCallFailed(direct, { result: { structuredContent: issue } }),
    true,
  );
  assert.equal(wireCallFailed(direct, { result: { content: text } }), true);
  assert.equal(
    wireCallFailed(facade, {
      result: { structuredContent: { outcome: "succeeded", content: text } },
    }),
    true,
  );
  assert.equal(
    wireCallFailed(direct, {
      result: { content: [{ type: "text", text: '{"results":[]}' }] },
    }),
    false,
  );
});

test(
  "the stdio relay attributes interleaved full and compact plans and preserves failed executions",
  { timeout: 30_000 },
  async (t) => {
    const dir = scratch(t),
      log = join(dir, "wire.jsonl");
    const relay = fileURLToPath(
      new URL("../benchmarks/two-host-wire.js", import.meta.url),
    );
    const backend = `
const rl=require("node:readline").createInterface({input:process.stdin});
let first;
const send=(msg)=>console.log(JSON.stringify({jsonrpc:"2.0",id:msg.id,result:msg.params.arguments.response}));
rl.on("line",line=>{const msg=JSON.parse(line);if(msg.id===1){first=msg;return;}send(msg);if(msg.id===2)send(first);});
`;
    const child = spawn(
      process.execPath,
      [relay, log, "facade", process.execPath, "-e", backend],
      { stdio: ["pipe", "pipe", "inherit"], signal: t.signal },
    );
    const closed = once(child, "close");
    const replies = createInterface({ input: child.stdout })[
      Symbol.asyncIterator
    ]();
    const call = (id: number, name: string, args: Record<string, unknown>) =>
      child.stdin.write(
        JSON.stringify({
          jsonrpc: "2.0",
          id,
          method: "tools/call",
          params: { name, arguments: args },
        }) + "\n",
      );
    const reply = async () => {
      const next = await replies.next();
      assert.equal(next.done, false);
      return (JSON.parse(next.value) as { id: number }).id;
    };
    try {
      call(1, "action.plan", {
        response: {
          structuredContent: {
            detail: "compact",
            actionId: "a",
            toolRef: "graph.search_graph",
          },
        },
      });
      call(2, "action.plan", {
        response: {
          structuredContent: {
            detail: "full",
            envelope: {
              actionId: "b",
              tool: { serverRef: "graph", toolName: "get_code_snippet" },
            },
          },
        },
      });
      assert.deepEqual([await reply(), await reply()], [2, 1]);
      call(3, "action.plan", {
        response: {
          isError: true,
          structuredContent: {
            detail: "compact",
            actionId: "c",
            toolRef: "graph.search_graph",
          },
        },
      });
      await reply();
      for (const [id, actionId, outcome] of [
        [4, "b", "failed"],
        [5, "a", "succeeded"],
        [6, "c", "succeeded"],
      ] as const) {
        call(id, "action.run", {
          actionId,
          response: { structuredContent: { outcome } },
        });
        await reply();
      }
    } finally {
      child.stdin.end();
      await closed;
    }
    const samples = readFileSync(log, "utf8")
      .trimEnd()
      .split("\n")
      .map((line) => wireSampleSchema.parse(JSON.parse(line)));
    assert.deepEqual(
      samples
        .filter((s) => s.tool === "action.run")
        .map((s) => [s.graphTool, s.error]),
      [
        ["get_code_snippet", true],
        ["search_graph", false],
        [undefined, false],
      ],
    );
  },
);
