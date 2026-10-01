import { test } from "node:test";
import assert from "node:assert/strict";
import {
  DEFAULT_TREE_PREFERENCES,
  withGenerationAnchor,
} from "../src/domain/tree-preferences.ts";

test("choosing an anchor enables generation defaults and preserves active depths without mutating preferences", () => {
  const enabled = withGenerationAnchor(
    { ...DEFAULT_TREE_PREFERENCES, generationLimits: null },
    "parent",
  );
  assert.deepEqual(enabled.generationLimits, {
    anchorId: "parent",
    ancestors: 3,
    descendants: 3,
    collateral: 1,
  });
  const preferences = {
    ...enabled,
    reverseTimeline: true,
    colorScheme: "white" as const,
    generationLimits: {
      anchorId: "parent",
      ancestors: 7 as const,
      descendants: 50 as const,
      collateral: 0 as const,
    },
  };
  const changed = withGenerationAnchor(preferences, "child");
  assert.deepEqual(changed, {
    ...preferences,
    generationLimits: { ...preferences.generationLimits, anchorId: "child" },
  });
  assert.equal(preferences.generationLimits.anchorId, "parent");
  assert.equal(DEFAULT_TREE_PREFERENCES.generationLimits, undefined);
});
