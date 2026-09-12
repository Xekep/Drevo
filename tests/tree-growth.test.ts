import assert from "node:assert/strict";
import test from "node:test";
import type { LayoutPerson } from "../src/domain/tree-layout.ts";
import {
  TREE_GROWTH_EDGE_MS,
  TREE_GROWTH_MAX_DELAY_MS,
  TREE_GROWTH_NODE_MS,
  treeConnectionGrowthStyle,
  treeGrowthDelays,
} from "../src/components/tree/tree-growth.ts";

function person(
  id: string,
  birth: string,
  parents: string[] = [],
  spouses: string[] = [],
): LayoutPerson {
  return { id, birth, parents, spouses };
}

test("tree growth follows birth dates and waits for the whole parent generation", () => {
  const people = [
    person("root", "1940-01-01"),
    person("older", "1965-01-01", ["root"], ["spouse"]),
    person("spouse", "1967-01-01", [], ["older"]),
    person("younger", "1968-01-01", ["root"]),
    person("unknown", "", ["root"]),
    person("grandchild", "1990-01-01", ["older"]),
  ];
  const delays = treeGrowthDelays(people);

  assert.ok(delays.get("older")! < delays.get("spouse")!);
  assert.ok(delays.get("spouse")! < delays.get("younger")!);
  assert.ok(delays.get("younger")! < delays.get("unknown")!);
  const parentGenerationReady =
    Math.max(
      delays.get("older")!,
      delays.get("spouse")!,
      delays.get("younger")!,
      delays.get("unknown")!,
    ) + TREE_GROWTH_NODE_MS;
  const grandchildLine = Number.parseInt(
    treeConnectionGrowthStyle(
      { from: "older", to: "grandchild", type: "parent" },
      delays,
    )["--tree-growth-delay"],
    10,
  );
  assert.equal(grandchildLine, parentGenerationReady);
  assert.equal(
    delays.get("grandchild"),
    parentGenerationReady + TREE_GROWTH_EDGE_MS,
  );
});

test("deep archives cap the animation instead of delaying the interface for minutes", () => {
  const people = Array.from({ length: 10_000 }, (_, index) =>
    person(
      `person-${index}`,
      String(1800 + Math.min(index, 199)),
      index ? [`person-${index - 1}`] : [],
    ),
  );
  const delays = treeGrowthDelays(people);
  assert.equal(delays.size, people.length);
  assert.equal(delays.get("person-9999"), TREE_GROWTH_MAX_DELAY_MS);
});
