import assert from "node:assert/strict";
import test from "node:test";
import {
  DEFAULT_TREE_PRINT,
  treePrintPlan,
} from "../src/components/tree/tree-print-plan.ts";

test("keeps the full-size landscape sheet by default", () => {
  const plan = treePrintPlan(5000, 1200, DEFAULT_TREE_PRINT);
  assert.deepEqual([plan.columns, plan.rows, plan.scale], [1, 1, 1]);
  assert.equal(plan.widthPt, 3750);
});

test("tiles A4 at the requested orientation, margin and scale", () => {
  const landscape = treePrintPlan(1123, 794, {
    paper: "a4",
    orientation: "landscape",
    marginMm: 10,
    scale: 1,
  });
  const portrait = treePrintPlan(1123, 794, {
    paper: "a4",
    orientation: "portrait",
    marginMm: 10,
    scale: 1,
  });
  assert.ok(landscape.widthPt > landscape.heightPt);
  assert.ok(portrait.widthPt < portrait.heightPt);
  assert.ok(landscape.columns * landscape.rows > 1);
  assert.ok(
    treePrintPlan(1123, 794, {
      paper: "a4",
      orientation: "landscape",
      marginMm: 10,
      scale: 0.5,
    }).columns <= landscape.columns,
  );
});

test("refuses excessive sheets instead of freezing the browser", () => {
  assert.throws(
    () =>
      treePrintPlan(100_000, 80_000, {
        paper: "a4",
        orientation: "landscape",
        marginMm: 10,
        scale: 1,
      }),
    /листов/,
  );
});
