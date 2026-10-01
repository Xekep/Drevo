import test from "node:test";
import assert from "node:assert/strict";
import { analyzeKinship, type Person } from "../src/domain/index.ts";

function lineage(distance: number, sex: Person["sex"]): Person[] {
  return Array.from({ length: distance + 1 }, (_, index) => ({
    id: `person-${index}`,
    name: "",
    surname: "",
    patronymic: "",
    sex,
    birth: "",
    birthPlace: "",
    parents: index ? [`person-${index - 1}`] : [],
    spouses: [],
    generation: index + 1,
    column: 0,
    sources: [],
  }));
}

test("four or more pra prefixes are counted for ancestors and descendants in both directions", () => {
  for (const sex of ["m", "f"] as const) {
    const ancestor = sex === "m" ? "дедушка" : "бабушка";
    const descendant = sex === "m" ? "внук" : "внучка";
    for (const count of [0, 1, 2, 3, 4, 5, 12]) {
      const distance = count + 2;
      const people = lineage(distance, sex);
      const first = people[0],
        last = people.at(-1)!;
      const prefix = count >= 4 ? `пра(${count})` : "пра".repeat(count);
      const down = analyzeKinship(first, last, people);
      const up = analyzeKinship(last, first, people);
      assert.equal(down.roles?.[0].term, prefix + ancestor);
      assert.equal(down.roles?.[1].term, prefix + descendant);
      assert.equal(up.roles?.[0].term, prefix + descendant);
      assert.equal(up.roles?.[1].term, prefix + ancestor);
      assert.deepEqual(down.distances, [0, distance]);
      assert.equal(down.path.length, distance + 1);
    }
  }
});

test("unknown sex keeps a neutral generation label", () => {
  const people = lineage(6, "u");
  const relation = analyzeKinship(people[0], people.at(-1)!, people);
  assert.equal(relation.roles?.[0].term, "предок через 6 поколений");
  assert.equal(relation.roles?.[1].term, "потомок через 6 поколений");
});
