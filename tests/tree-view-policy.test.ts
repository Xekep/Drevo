import test from "node:test";
import assert from "node:assert/strict";
import { treeViewTransition, treeViewPresentation, treeViewPolicy, type TreeViewState } from "../src/domain/tree-view-policy.ts";

test("mode transitions atomically leave the fan and preserve its intended return mode", () => {
  let state: TreeViewState = { kind: "canvas", mode: "timeline" };
  state = treeViewTransition(state, { type: "fan", anchorId: "a" });
  assert.deepEqual(state, { kind: "fan", mode: "timeline", anchorId: "a" });
  state = treeViewTransition(state, { type: "fan", anchorId: "b" });
  assert.deepEqual(state, { kind: "fan", mode: "timeline", anchorId: "b" });
  assert.deepEqual(treeViewTransition(state, { type: "fan", anchorId: null }), { kind: "canvas", mode: "timeline" });
  assert.deepEqual(treeViewTransition(state, { type: "mode", mode: "generations" }), { kind: "canvas", mode: "generations" });
  const left = treeViewTransition(state, { type: "mode", mode: "timeline" });
  assert.deepEqual(treeViewTransition(left, { type: "reanchor-fan", anchorId: "c", previousAnchor: "b" }), left,
    "a late person navigation must not reopen a fan after a mode switch");
  assert.deepEqual(treeViewTransition(state, { type: "reanchor-fan", anchorId: "c", previousAnchor: "a" }), state,
    "an obsolete navigation must not replace a newer fan anchor");
});

test("projection, gestures and fragments agree across the complete view-policy matrix", () => {
  for (const mode of ["generations", "timeline"] as const)
    for (const fanAnchor of [null, "a"])
      for (const presentation of ["flat", "depth"] as const)
        for (const depthUnavailable of [false, true])
          for (const familyMode of ["all", "family", "common"] as const)
            for (const replacingFilter of [false, true])
              for (const preview of [false, true]) {
                const expected = fanAnchor ? "fan" : mode === "timeline" ? "timeline"
                  : presentation === "depth" && !depthUnavailable ? "depth" : "tree";
                const policy = treeViewPolicy({ ...treeViewPresentation({ mode, fanAnchor, presentation, depthUnavailable }),
                  familyMode, replacingFilter, preview });
                assert.equal(policy.kind, expected);
                assert.equal(policy.depthEnabled, expected === "depth");
                assert.equal(policy.timelineActive, expected === "timeline");
                assert.equal(policy.flatTree, expected === "tree");
                assert.equal(policy.fragmentEnabled, ["tree", "depth"].includes(expected) && familyMode === "all" && !replacingFilter && !preview);
              }
});
