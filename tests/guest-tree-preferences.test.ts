import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import {
  readGuestTreePreferences,
  writeGuestTreePreferences,
} from "../src/data/guest-tree-preferences.ts";
import { DEFAULT_TREE_PREFERENCES } from "../src/domain/tree-preferences.ts";

function storageMock(
  t: TestContext,
  value: Pick<Storage, "getItem" | "setItem">,
) {
  const descriptor = Object.getOwnPropertyDescriptor(
    globalThis,
    "localStorage",
  );
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    value,
  });
  t.after(() => {
    if (descriptor)
      Object.defineProperty(globalThis, "localStorage", descriptor);
    else Reflect.deleteProperty(globalThis, "localStorage");
  });
}

test("guest preferences store only view options and keep the archive defaults when missing", (t) => {
  let raw: string | null = null;
  storageMock(t, {
    getItem: () => raw,
    setItem: (_key: string, value: string) => {
      raw = value;
    },
  });
  const fallback = { ...DEFAULT_TREE_PREFERENCES, reverseTimeline: true };
  assert.deepEqual(readGuestTreePreferences(fallback), fallback);
  const value = {
    ...fallback,
    cardVariant: "portrait" as const,
    colorScheme: "white" as const,
  };
  writeGuestTreePreferences({
    ...value,
    token: "must-not-be-stored",
  } as typeof value);
  assert.deepEqual(readGuestTreePreferences(fallback), value);
  assert.deepEqual(JSON.parse(raw!), value);
});

test("corrupt and unavailable guest storage cannot prevent opening the tree", (t) => {
  let raw = "invalid json";
  storageMock(t, {
    getItem: () => {
      if (raw === "blocked") throw new Error("blocked");
      return raw;
    },
    setItem: () => {
      throw new Error("blocked");
    },
  });
  assert.deepEqual(
    readGuestTreePreferences(DEFAULT_TREE_PREFERENCES),
    DEFAULT_TREE_PREFERENCES,
  );
  raw =
    '{"reverseTimeline":"false","cardVariant":"unknown","colorScheme":"white"}';
  assert.deepEqual(readGuestTreePreferences(DEFAULT_TREE_PREFERENCES), {
    ...DEFAULT_TREE_PREFERENCES,
    colorScheme: "white",
  });
  assert.doesNotThrow(() =>
    writeGuestTreePreferences(DEFAULT_TREE_PREFERENCES),
  );
  raw = "blocked";
  assert.deepEqual(
    readGuestTreePreferences(DEFAULT_TREE_PREFERENCES),
    DEFAULT_TREE_PREFERENCES,
  );
});

test("guest generation limits survive reload and can be cleared without storing unrelated fields", (t) => {
  let raw: string | null = null;
  storageMock(t, {
    getItem: () => raw,
    setItem: (_key, value) => {
      raw = value;
    },
  });
  const value = {
    ...DEFAULT_TREE_PREFERENCES,
    generationLimits: {
      anchorId: "main",
      ancestors: 3 as const,
      descendants: 2 as const,
      collateral: 0 as const,
    },
  };
  writeGuestTreePreferences(value);
  assert.deepEqual(readGuestTreePreferences(DEFAULT_TREE_PREFERENCES), value);
  writeGuestTreePreferences({ ...value, generationLimits: null });
  assert.deepEqual(
    readGuestTreePreferences(DEFAULT_TREE_PREFERENCES),
    DEFAULT_TREE_PREFERENCES,
  );
  raw = JSON.stringify({
    ...value,
    generationLimits: { ...value.generationLimits, ancestors: 999 },
  });
  assert.deepEqual(
    readGuestTreePreferences(DEFAULT_TREE_PREFERENCES),
    DEFAULT_TREE_PREFERENCES,
  );
});
