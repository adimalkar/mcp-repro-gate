import assert from "node:assert/strict";
import test from "node:test";
import { parseUniqueJson } from "../src/unique-json.js";

test("signed wire JSON compares decoded member names within each object", () => {
  for (const wire of [
    '{"decision":"allow","decision":"allow"}',
    String.raw`[{"key":1,"\u006bey":2}]`,
    '{"__proto__":1,"__proto__":2}',
    '{"outer":{"a":1},"outer":{}}',
  ])
    assert.throws(() => parseUniqueJson(wire), /Duplicate JSON member/u);
  const wire = JSON.stringify([
    { key: 'a":{\\}' },
    { key: null },
    { nested: { key: [] }, key: true },
  ]);
  assert.deepEqual(parseUniqueJson(wire), JSON.parse(wire));
  assert.throws(
    () => parseUniqueJson('{"private input":'),
    /^SyntaxError: Invalid JSON$/u,
  );
});
