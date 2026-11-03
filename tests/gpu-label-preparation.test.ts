import assert from "node:assert/strict";
import test from "node:test";
import { scheduleGpuLabelPreparation } from "../src/components/tree/gpu-label-preparation.ts";
import { createPersonRelationLabels, kinshipLabelKey } from "../src/components/tree/person-relation-label.ts";
import { kinshipGraphs } from "./fixtures/kinship-graphs.ts";

test("cold labels yield between bounded batches and preserve the existing kinship oracle", async () => {
  const people = kinshipGraphs().flatMap(graph => graph.people);
  // Use each graph independently, retaining its original links and unions.
  for (const graph of kinshipGraphs()) {
    const reference = graph.people.at(-1)!.id;
    const key = kinshipLabelKey(graph.people, graph.links || [], graph.unions || [], "2026-11-04");
    const read = createPersonRelationLabels(key, reference);
    const expected = graph.people.map(createPersonRelationLabels(key, reference));
    const actual: string[] = [];
    await new Promise<void>((resolve, reject) => {
      scheduleGpuLabelPreparation(graph.people.length, index => actual.push(read(graph.people[index])), resolve,
        () => reject(new Error("label preparation failed")));
      assert.equal(actual.length, 0, "starting preparation must not perform a cold search");
    });
    assert.deepEqual(actual, expected);
  }
  assert.ok(people.length > 32);
});

test("cached labels still yield and cancellation drops queued work and completion", t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let calls = 0, completed = false;
  const cancel = scheduleGpuLabelPreparation(100, () => { calls++; }, () => { completed = true; },
    () => assert.fail("unexpected failure"));
  assert.equal(calls, 0);
  t.mock.timers.tick(1);
  assert.ok(calls > 0 && calls <= 32);
  assert.equal(completed, false);
  const before = calls;
  cancel();
  t.mock.timers.tick(1000);
  assert.equal(calls, before);
  assert.equal(completed, false);
});

test("failed preparation reports once and never publishes a partial result", t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let calls = 0, failures = 0;
  scheduleGpuLabelPreparation(100, () => { calls++; throw new Error("failed"); },
    () => assert.fail("partial labels must not complete"), () => { failures++; });
  t.mock.timers.tick(1000);
  assert.equal(calls, 1);
  assert.equal(failures, 1);
});
