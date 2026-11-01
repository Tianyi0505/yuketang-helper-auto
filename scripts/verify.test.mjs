import assert from "node:assert/strict";
import test from "node:test";
import { getCheckPlan, parseArgs } from "./verify.mjs";

const expectedFastPlan = [
  {
    name: "CLI unit tests",
    cwd: ".",
    fullOnly: false,
    command: { type: "node", args: ["--test", "scripts/verify.test.mjs"] },
  },
  {
    name: "ykt-helper test",
    cwd: "ykt-helper",
    fullOnly: false,
    command: { type: "npm", script: "test" },
  },
  {
    name: "ykt-helper test:model-params",
    cwd: "ykt-helper",
    fullOnly: false,
    command: { type: "npm", script: "test:model-params" },
  },
  {
    name: "ykt-helper-win test",
    cwd: "ykt-helper-win",
    fullOnly: false,
    command: { type: "npm", script: "test" },
  },
  {
    name: "ykt-helper-win lint",
    cwd: "ykt-helper-win",
    fullOnly: false,
    command: { type: "npm", script: "lint" },
  },
  {
    name: "ykt-helper-win format:check",
    cwd: "ykt-helper-win",
    fullOnly: false,
    command: { type: "npm", script: "format:check" },
  },
];

const expectedFullPlan = [
  ...expectedFastPlan,
  {
    name: "ykt-helper test:debug",
    cwd: "ykt-helper",
    fullOnly: true,
    command: { type: "npm", script: "test:debug" },
  },
  {
    name: "ykt-helper-win build",
    cwd: "ykt-helper-win",
    fullOnly: true,
    command: { type: "npm", script: "build" },
  },
];

test("parseArgs selects fast mode by default", () => {
  assert.deepEqual(parseArgs([]), { full: false, help: false });
});

test("parseArgs accepts full and help options", () => {
  assert.deepEqual(parseArgs(["--full", "--help"]), { full: true, help: true });
});

test("parseArgs rejects unknown arguments", () => {
  assert.throws(() => parseArgs(["--unknown"]), /Unknown argument: --unknown/);
});

test("getCheckPlan returns the exact fast plan", () => {
  assert.deepEqual(getCheckPlan(), expectedFastPlan);
});

test("getCheckPlan returns the exact full plan", () => {
  assert.deepEqual(getCheckPlan(true), expectedFullPlan);
});
