import test from "node:test";
import assert from "node:assert/strict";
import { solveBoundedSat } from "../src/domain/bounded-sat.ts";

test("bounded SAT agrees with exhaustive search on deterministic small formulas", () => {
  let state = 17;
  const random = () =>
    (state = (Math.imul(state, 1664525) + 1013904223) >>> 0) >>> 8;
  for (let sample = 0; sample < 400; sample++) {
    const count = 1 + (random() % 7);
    const clauses = Array.from({ length: random() % 35 }, () =>
      Array.from(
        { length: 1 + (random() % 4) },
        () => (1 + (random() % count)) * (random() % 2 ? 1 : -1),
      ),
    );
    const snapshot = structuredClone(clauses);
    const valid = (values: ArrayLike<number>) =>
      clauses.every((c) =>
        c.some((l) => values[Math.abs(l)] * Math.sign(l) > 0),
      );
    let possible = false;
    for (let mask = 0; mask < 1 << count; mask++)
      if (
        valid(
          Array.from({ length: count + 1 }, (_, i) =>
            mask & (1 << (i - 1)) ? 1 : -1,
          ),
        )
      ) {
        possible = true;
        break;
      }
    const result = solveBoundedSat(count, clauses, [], {
      remaining: 1_000_000,
    });
    assert.notEqual(result, undefined, `budget for sample ${sample}`);
    assert.equal(
      result !== null,
      possible,
      `satisfiability for sample ${sample}`,
    );
    if (result) assert.ok(valid(result));
    assert.deepEqual(clauses, snapshot);
  }
});

test("an exhausted budget is unknown, not a false proof of unsatisfiability", () => {
  assert.equal(
    solveBoundedSat(
      3,
      [
        [1, 2],
        [-1, 3],
      ],
      [],
      { remaining: 0 },
    ),
    undefined,
  );
  assert.equal(solveBoundedSat(1, [[1], [-1]], [], { remaining: 100 }), null);
  assert.equal(solveBoundedSat(1, [[]], [], { remaining: 100 }), null);
});
