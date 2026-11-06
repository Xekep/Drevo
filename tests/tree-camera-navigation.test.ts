import test from "node:test";
import assert from "node:assert/strict";
import {
  treeCameraNavigation,
  type CameraNavigationState,
  type BranchNavigationAnchor,
} from "../src/domain/tree-camera-navigation.ts";

const initial = (): CameraNavigationState => ({
  scope: "archive:owner",
  sequence: 0,
  request: null,
  fanEntry: null,
});
const anchor = (): BranchNavigationAnchor => ({
  personId: "a",
  occurrenceId: "a",
  position: { x: 100, y: 200 },
  viewport: { x: 20, y: 30, zoom: 0.3 },
  layoutKey: "before",
  context: "all",
});

test("an obsolete camera completion cannot clear a newer person or branch request", () => {
  let state = treeCameraNavigation(initial(), { type: "person", id: "a" });
  const first = state.request!.token;
  state = treeCameraNavigation(state, { type: "person", id: "b" });
  assert.equal(
    treeCameraNavigation(state, {
      type: "clear",
      kind: "person",
      token: first,
    }),
    state,
  );
  const second = state.request!.token;
  state = treeCameraNavigation(state, { type: "branch", anchor: anchor() });
  assert.equal(state.request!.kind, "branch");
  assert.equal(
    treeCameraNavigation(state, {
      type: "clear",
      kind: "person",
      token: second,
    }),
    state,
  );
  assert.equal(
    treeCameraNavigation(state, { type: "clear", kind: "person" }),
    state,
    "clearing a former return target after capturing the branch must retain the branch anchor",
  );
  assert.equal(
    treeCameraNavigation(state, { type: "clear", kind: "branch" }).request,
    null,
  );
});

test("fan return restores only the same person, mode and family projection", () => {
  const entry = {
    anchorId: "a",
    mode: "generations" as const,
    familyMode: "all" as const,
    viewport: { x: 120, y: -80, zoom: 0.27 },
  };
  let entered = treeCameraNavigation(initial(), { type: "person", id: "old" });
  entered = treeCameraNavigation(entered, { type: "enter-fan", entry });
  assert.equal(entered.request, null);
  assert.deepEqual(
    treeCameraNavigation(entered, {
      type: "leave-fan",
      targetId: "a",
      mode: "generations",
      familyMode: "all",
    }).request,
    { kind: "restore", viewport: entry.viewport, token: 2 },
  );
  for (const change of [
    { targetId: "b", mode: "generations" as const, familyMode: "all" as const },
    { targetId: "a", mode: "timeline" as const, familyMode: "all" as const },
    {
      targetId: "a",
      mode: "generations" as const,
      familyMode: "common" as const,
    },
  ]) {
    const left = treeCameraNavigation(entered, {
      type: "leave-fan",
      ...change,
    });
    assert.deepEqual(left.request, {
      kind: "person",
      id: change.targetId,
      token: 2,
    });
    assert.equal(left.fanEntry, null);
  }
  assert.equal(
    treeCameraNavigation(entered, {
      type: "leave-fan",
      targetId: null,
      mode: "generations",
      familyMode: "all",
    }).request,
    null,
  );
});

test("a completed old viewport restoration cannot cancel a new restoration", () => {
  const entry = {
    anchorId: "a",
    mode: "generations" as const,
    familyMode: "family" as const,
    viewport: { x: 0, y: 0, zoom: 0.6 },
  };
  let state = treeCameraNavigation(initial(), { type: "enter-fan", entry });
  state = treeCameraNavigation(state, {
    type: "leave-fan",
    targetId: "a",
    mode: "generations",
    familyMode: "family",
  });
  const old = state.request!.token;
  state = treeCameraNavigation(state, { type: "enter-fan", entry });
  state = treeCameraNavigation(state, {
    type: "leave-fan",
    targetId: "a",
    mode: "generations",
    familyMode: "family",
  });
  assert.equal(
    treeCameraNavigation(state, { type: "clear", kind: "restore", token: old }),
    state,
  );
  assert.equal(
    treeCameraNavigation(state, {
      type: "clear",
      kind: "restore",
      token: state.request!.token,
    }).request,
    null,
  );
});

test("navigation snapshots copy geometry and disappear before a changed access scope is displayed", () => {
  const captured = anchor();
  const branch = treeCameraNavigation(initial(), {
    type: "branch",
    anchor: captured,
  });
  captured.position.x = 999;
  captured.viewport.zoom = 9;
  assert.equal(
    branch.request?.kind === "branch" && branch.request.position.x,
    100,
  );
  assert.equal(
    branch.request?.kind === "branch" && branch.request.viewport.zoom,
    0.3,
  );
  const entered = treeCameraNavigation(branch, {
    type: "enter-fan",
    entry: {
      anchorId: "a",
      mode: "generations",
      familyMode: "all",
      viewport: captured.viewport,
    },
  });
  captured.viewport.zoom = 10;
  assert.equal(entered.fanEntry?.viewport.zoom, 9);
  const reset = treeCameraNavigation(entered, {
    type: "scope",
    scope: "archive:reader",
  });
  assert.equal(reset.request, null);
  assert.equal(reset.fanEntry, null);
  const fresh = treeCameraNavigation(reset, { type: "person", id: "visible" });
  assert.ok(fresh.request!.token > branch.request!.token);
});
