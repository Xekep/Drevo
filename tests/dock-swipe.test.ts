import test from "node:test";
import assert from "node:assert/strict";
import { dockSwipeAction } from "../src/components/dock-swipe.ts";

test("a deliberate downward pull or a short flick closes the card", () => {
  assert.equal(dockSwipeAction(8, 90, 800, true), "close");
  assert.equal(dockSwipeAction(4, 36, 50, true), "close");
  assert.equal(dockSwipeAction(0, 80, 500, false), "close");
});
test("taps, slow short drags and mostly horizontal gestures leave the card open", () => {
  assert.equal(dockSwipeAction(0, 5, 1, true), "reset");
  assert.equal(dockSwipeAction(0, 36, 400, true), "reset");
  assert.equal(dockSwipeAction(100, 80, 80, true), "reset");
  assert.equal(dockSwipeAction(0, 0, 0, true), "reset");
});
test("upward gestures expand only a collapsed card and never dismiss it", () => {
  assert.equal(dockSwipeAction(4, -70, 300, false), "expand");
  assert.equal(dockSwipeAction(4, -70, 300, true), "reset");
  assert.equal(dockSwipeAction(0, -20, 20, false), "reset");
  assert.equal(dockSwipeAction(100, -70, 100, false), "reset");
});
