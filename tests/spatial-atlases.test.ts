import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import {
  SpatialCardAtlas,
  spatialPortraitTile,
} from "../src/components/tree/spatial-card-atlas.ts";
import { SpatialNameAtlas } from "../src/components/tree/spatial-name-atlas.ts";
import { SpatialLabelMask } from "../src/components/tree/spatial-label-mask.ts";
import type { Person } from "../src/domain/types.ts";

const palette = {
  paper: "#fff",
  ink: "#123",
  muted: "#456",
  green: "#273",
  red: "#933",
};
const person = (i: number): Person => ({
  id: String(i),
  surname: "Соколов",
  name: "Александр",
  patronymic: "Николаевич",
  birth: "1970",
  birthPlace: "",
  sex: "u",
  generation: 1,
  column: 0,
  parents: [],
  spouses: [],
  sources: [],
  photo: `/media/person-${i}.jpg`,
});

function fixture(t: TestContext) {
  const images: FakeImage[] = [];
  class FakeImage {
    src = "";
    crossOrigin = "";
    naturalWidth = 128;
    naturalHeight = 128;
    onload: (() => void) | null = null;
    onerror: (() => void) | null = null;
    constructor() {
      images.push(this);
    }
  }
  const drawn: unknown[][] = [];
  const context = new Proxy(
    {
      measureText: (s: string) => ({ width: [...s].length * 14 }),
      drawImage: (...args: unknown[]) => drawn.push(args),
    },
    { get: (target, key) => Reflect.get(target, key) ?? (() => {}) },
  );
  for (const [key, value] of Object.entries({
    Image: FakeImage,
    document: {
      createElement: () => ({ width: 0, height: 0, getContext: () => context }),
    },
  })) {
    const old = Object.getOwnPropertyDescriptor(globalThis, key);
    Object.defineProperty(globalThis, key, { configurable: true, value });
    t.after(() =>
      old
        ? Object.defineProperty(globalThis, key, old)
        : Reflect.deleteProperty(globalThis, key),
    );
  }
  return {
    images,
    drawn,
    pending: () => images.filter((image) => image.src && image.onload),
  };
}

test("1000 portraits share one fixed page, retain all UVs, and never exceed four decoded loaders", (t) => {
  const f = fixture(t);
  const atlas = new SpatialCardAtlas(palette, () => {}, 1000);
  t.after(() => atlas.dispose());
  const people = Array.from({ length: 1000 }, (_, i) => person(i));
  atlas.update(people);
  assert.equal(atlas.canvas.width * atlas.canvas.height * 4, 16 * 1024 * 1024);
  assert.equal(atlas.tile, 64);
  assert.equal(new Set(people.map((p) => atlas.uv(p.id).join())).size, 1000);
  while (f.pending().length) {
    assert.ok(f.pending().length <= 4);
    f.pending()[0].onload!();
  }
  assert.equal(f.drawn.length, 1000);
  const uv = atlas.uv("700");
  atlas.update([...people].reverse());
  assert.deepEqual(atlas.uv("700"), uv);
  assert.equal(
    f.images.length,
    1000,
    "camera ordering must not reload resident portraits",
  );
  atlas.update(people.map((p) => ({ ...p, birth: "1980" })));
  assert.equal(
    f.images.length,
    1000,
    "unrelated field edits preserve portrait pixels",
  );
});

test("archives beyond the portrait page reuse revoked slots within the same memory bound", (t) => {
  const f = fixture(t);
  const atlas = new SpatialCardAtlas(palette, () => {}, 20_000);
  t.after(() => atlas.dispose());
  atlas.update(Array.from({ length: 16_384 }, (_, i) => person(i)));
  const first = atlas.uv("0");
  const stale = f.pending()[0].onload!;
  atlas.update([person(18_000)]);
  assert.deepEqual(atlas.uv("18000"), first);
  stale();
  assert.equal(f.drawn.length, 0);
  assert.equal(atlas.canvas.width * atlas.canvas.height * 4, 16 * 1024 * 1024);
});

test("portrait revocation and disposal cancel loaders and ignore stale completions", (t) => {
  const f = fixture(t);
  const atlas = new SpatialCardAtlas(palette, () => {}, 200);
  const people = Array.from({ length: 10 }, (_, i) => person(i));
  atlas.update(people);
  const cancelled = f.pending()[0],
    late = cancelled.onload!;
  atlas.update(people.slice(4));
  assert.equal(cancelled.src, "");
  late();
  assert.equal(f.drawn.length, 0);
  const pending = f.pending().map((image) => ({ image, late: image.onload! }));
  atlas.dispose();
  for (const { image, late } of pending) {
    assert.equal(image.src, "");
    late();
  }
  assert.equal(f.drawn.length, 0);
  assert.equal(atlas.canvas.width, 1);
});

test("portrait packing degrades resolution within the same 16 MiB bound", () => {
  assert.deepEqual(
    [200, 1000, 4000, 20_000].map(spatialPortraitTile),
    [128, 64, 32, 16],
  );
});

test("a thousand full names share sharp glyphs independently of portrait resolution", (t) => {
  fixture(t);
  const atlas = new SpatialNameAtlas(palette);
  t.after(() => atlas.dispose());
  const people = Array.from({ length: 1000 }, (_, i) => person(i));
  atlas.update(people);
  assert.equal(atlas.canvas.width * atlas.canvas.height * 4, 4 * 1024 * 1024);
  const first = atlas.layout(people[0]),
    last = atlas.layout(people[999]);
  assert.deepEqual(first, last);
  assert.ok(first.length > 30, "all three name fields and dates are retained");
  assert.ok(first.some((glyph) => glyph.date === 1));
  assert.ok(first.every((glyph) => glyph.tile[2] === 32 / 1024));
  assert.ok(first.every((glyph) => glyph.layout.every(Number.isFinite)));
});

test("screen mask remains bounded across large viewports and dense archives", (t) => {
  fixture(t);
  const mask = new SpatialLabelMask();
  t.after(() => mask.dispose());
  mask.update(
    Array.from({ length: 1000 }, (_, i) => ({ x: i, y: i / 2, size: 40, z: 0.99 })),
    7680,
    4320,
  );
  assert.equal(mask.canvas.width * mask.canvas.height * 4, 1024 * 1024);
});
