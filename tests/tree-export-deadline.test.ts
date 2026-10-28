import assert from "node:assert/strict";
import test from "node:test";
import { treeExportDeadline } from "../src/components/tree/tree-export-deadline.ts";

test("a progressing export outlives its initial idle deadline, but stalls still expire", context => {
  context.mock.timers.enable({ apis: ["setTimeout"] });
  const failures: string[] = [];
  const deadline = treeExportDeadline(reason => failures.push(reason), 30, 180);
  for (let index = 0; index < 4; index++) {
    context.mock.timers.tick(25);
    deadline.progress();
  }
  assert.deepEqual(failures, []);
  context.mock.timers.tick(30);
  assert.deepEqual(failures, ["idle"]);
  context.mock.timers.tick(300);
  assert.deepEqual(failures, ["idle"], "a timeout is delivered only once");
});

test("progress cannot extend the total export budget and cleanup prevents later errors", context => {
  context.mock.timers.enable({ apis: ["setTimeout"] });
  const failures: string[] = [];
  const deadline = treeExportDeadline(reason => failures.push(reason), 30, 100);
  for (let index = 0; index < 4; index++) {
    context.mock.timers.tick(25);
    deadline.progress();
  }
  assert.deepEqual(failures, ["total"]);
  const completed = treeExportDeadline(reason => failures.push(reason), 30, 100);
  completed.dispose();
  completed.progress();
  context.mock.timers.tick(200);
  assert.deepEqual(failures, ["total"]);
});
