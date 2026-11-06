# Measuring graph discovery against grep

The first local fixture run reduced implementation-reading response bytes by
**74.3% at the median** versus grep plus complete matched-file reads. Exact-name
location queries returned **more** bytes than grep alone. Neither comparison
meets the roadmap's >90% target. These are bytes, not host tokens.

## Reproduce

This is an optional developer harness, separate from the installed ReproGate
CLI. It requires the locked development dependencies, Git, ripgrep, and an
explicit local codebase-memory-mcp binary. The published run used version
0.9.0; the harness does not install it.

    npm ci
    npm run bench:code-discovery -- --graph-bin /absolute/path/to/codebase-memory-mcp

To save a report without npm's output:

    npm run build --silent
    node dist/benchmarks/code-discovery.js \
      --graph-bin /absolute/path/to/codebase-memory-mcp > /tmp/discovery-report.json

The pinned source commit must exist locally. A shallow checkout may need to
fetch 6eabc20f04f1a0fe9edede5ab36a4338000bd155 first. The harness reads Git
objects; it never reads uncommitted source from the working tree.

## Fixture and comparisons

Fixture v1 exports the 37 TypeScript files (355,562 UTF-8 bytes) in the pinned
commit's src/ tree into a temporary corpus. Six tasks name a function and
require its expected file and an implementation fragment. They cover canonical
JSON, policy evaluation, capability issuance, receipt verification, Git plan
binding, and Git review configuration loading. These are exact-name lookup
tasks, not natural-language exploration or call-graph reasoning tasks.

For each task:

1. Graph: search_graph with an anchored exact name, label "Function" and
   limit 10, then get_code_snippet for the single returned qualified name.
2. Text: the following rg command, then read each matched file completely,
   once per task:

       rg --no-config --no-ignore --color never --sort path --with-filename \
         --line-number --word-regexp --fixed-strings -- <name> src

Location-only compares the graph search response with the rg stdout.
Implementation-reading compares both graph responses with the rg stdout plus
all matched-file contents. Full matched-file reads are an explicit baseline
workflow; a reader can instead narrow the grep to definitions or read only
selected lines. This fixture does not measure that more efficient workflow.
Every task starts independently: neither side reuses earlier task responses.

The graph result must identify exactly one expected symbol without pagination.
The snippet's path, line range and source must match the pinned file exactly,
and include the expected implementation fragment. The baseline must find the
expected file and return the answer. Errors, missing answers, invalid matches,
ambiguous symbols, truncation and binary changes fail the run without a report.

## Accounting and published run

Count complete JSON MCP result payloads, including text, structured mirrors,
and any metadata. Count raw UTF-8 stdout and file contents for the text workflow.
JSON-RPC framing is excluded. Logical request bytes and call counts are also
reported; shell/file request objects describe this harness's operations, not
the wire format of a particular host.

The reduction is 1 - graphResponseBytes / baselineResponseBytes, computed per
task before taking the median. Negative values are retained. The two workflows
return different kinds of context, so output size alone says nothing about
reasoning quality or task completion beyond the declared answer checks.

[The complete local report](benchmarks/code-discovery-v1.json) contains tool
versions, binary digest, Git revision/tree, per-file source digests, setup
response, all task requests/responses, answer checks, and the measured sizes.
It was recorded on Linux with Node 22.23.3, codebase-memory-mcp 0.9.0 and
ripgrep 15.2.0.

| Function                           | Graph locate B | Grep B | Graph locate + read B | Grep + full files B | Implementation reduction |
| ---------------------------------- | -------------: | -----: | --------------------: | ------------------: | -----------------------: |
| canonicalJson                      |          2,940 |  2,623 |                 9,746 |             133,811 |                    92.7% |
| evaluatePolicy                     |          2,994 |    610 |                 8,065 |              30,986 |                    74.0% |
| issueCapabilityToken               |          3,296 |    339 |                 8,197 |              25,592 |                    68.0% |
| verifyExecutionReceipt             |          3,005 |    222 |                 8,259 |              12,317 |                    32.9% |
| deriveGitApprovalAuthorityFromPlan |          3,701 |  1,358 |                15,048 |              59,282 |                    74.6% |
| loadGitReviewConfigSnapshot        |          3,193 |    413 |                 8,029 |              43,226 |                    81.4% |

All six answer checks passed. Median location-only reduction was **-532.0%**;
median implementation-reading reduction was **74.3%**. The report flags both

> 90% targets as unmet.

## Side effects and limits

The explicit binary is trusted local software. A fresh private CBM_CACHE_DIR
and XDG directories isolate graph indexes and saved settings. Auto-watch and
auto-index are disabled in that private configuration, and the UI is disabled
for the MCP process. Indexing uses persistence false, so it does not export
tracked .codebase-memory artifacts. The MCP client closes before temporary
state is removed on normal success or failure. A hard kill can leave temporary
state. This is configuration isolation, not an OS sandbox.

The full report retains copies of public pinned source and temporary absolute
paths. Existing user configuration and indexes are not included. Do not replace
the fixture with private source without reviewing what the report retains.

The run uses a direct MCP client, not the gateway. It excludes tool definitions,
initialization, indexing and setup costs from task sizes and records the index
response separately. It measures neither index performance nor latency,
tokenization, gateway planning/receipt overhead, approval time or model task
success. CI tests failure handling and replays the published artifact without
installing or launching the graph binary. Two-host evaluation and the roadmap's
token targets remain open.
