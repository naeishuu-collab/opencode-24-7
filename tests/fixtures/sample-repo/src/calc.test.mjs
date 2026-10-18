import { test } from "node:test";
import assert from "node:assert/strict";
import { add, mul } from "./calc.mjs";

test("add sums two numbers", () => {
  assert.equal(add(2, 3), 5);
});

test("mul multiplies two numbers", () => {
  assert.equal(mul(2, 3), 6);
});
