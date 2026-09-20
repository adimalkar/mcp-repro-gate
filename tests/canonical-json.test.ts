import assert from "node:assert/strict";
import test from "node:test";

import { canonicalJson } from "../src/canonical-json.js";
import { digestCanonical } from "../src/digest.js";

test("canonical JSON is independent of object insertion order", () => {
  const left = { z: 1, nested: { b: true, a: [3, 2, 1] } };
  const right = { nested: { a: [3, 2, 1], b: true }, z: 1 };
  assert.equal(canonicalJson(left), canonicalJson(right));
  assert.equal(digestCanonical(left), digestCanonical(right));
});

test("canonical JSON preserves array order", () => {
  assert.notEqual(digestCanonical([1, 2]), digestCanonical([2, 1]));
});

test("canonical JSON rejects values that JSON would silently coerce", () => {
  assert.throws(() => canonicalJson({ missing: undefined }), /Unsupported/);
  assert.throws(() => canonicalJson(Number.NaN), /Non-finite/);
  assert.throws(() => canonicalJson(new Date()), /Non-plain/);
});

test("canonical JSON rejects cycles", () => {
  const value: { self?: unknown } = {};
  value.self = value;
  assert.throws(() => canonicalJson(value), /Cyclic/);
});
