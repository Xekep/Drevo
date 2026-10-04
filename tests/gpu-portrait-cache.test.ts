import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { GpuPortraitCache } from "../src/components/tree/gpu-portrait-cache.ts";

const photos = (count: number) =>
  Array.from({ length: count }, (_, index) => `/media/portrait-${index}.jpg`);

function fixture(t: TestContext) {
  const images: FakeImage[] = [];
  class FakeImage {
    onload: (() => void) | null = null;
    onerror: (() => void) | null = null;
    src = "";
    naturalWidth = 48;
    naturalHeight = 48;
    constructor() {
      images.push(this);
    }
  }
  const canvas = {
    width: 0,
    height: 0,
    getContext: () => ({
      drawImage: () => {},
      getImageData: (
        _x: number,
        _y: number,
        width: number,
        height: number,
      ) => ({
        data: new Uint8ClampedArray(width * height * 4),
      }),
    }),
  };
  for (const [key, value] of Object.entries({
    Image: FakeImage,
    document: {
      createElement: () => canvas,
    },
  })) {
    const previous = Object.getOwnPropertyDescriptor(globalThis, key);
    Object.defineProperty(globalThis, key, { configurable: true, value });
    t.after(() => {
      if (previous) Object.defineProperty(globalThis, key, previous);
      else Reflect.deleteProperty(globalThis, key);
    });
  }
  const uploads: { texture: object; x: number; y: number; size: number }[] = [];
  const storage: number[][] = [];
  const deleted: object[] = [];
  const mipmaps: object[] = [];
  let textureCount = 0,
    bound: object,
    redraws = 0,
    failures = 0;
  const gl = {
    TEXTURE_2D: 1,
    R8: 2,
    RGBA8: 3,
    TEXTURE_MIN_FILTER: 4,
    LINEAR_MIPMAP_LINEAR: 5,
    TEXTURE_MAG_FILTER: 6,
    LINEAR: 7,
    TEXTURE_WRAP_S: 8,
    TEXTURE_WRAP_T: 9,
    CLAMP_TO_EDGE: 10,
    RED: 11,
    UNSIGNED_BYTE: 12,
    RGBA: 13,
    createTexture: (): object | null => ({ id: ++textureCount }),
    bindTexture: (_target: number, texture: object) => {
      bound = texture;
    },
    texStorage2D: (...args: number[]) => {
      storage.push(args);
    },
    texParameteri: () => {},
    texSubImage2D: (...args: unknown[]) => {
      uploads.push({
        texture: bound,
        x: args[2] as number,
        y: args[3] as number,
        size:
          typeof args[4] === "number" && args.length === 9
            ? args[4]
            : canvas.width,
      });
    },
    generateMipmap: () => {
      mipmaps.push(bound);
    },
    deleteTexture: (texture: object) => {
      deleted.push(texture);
    },
  };
  const redraw = () => {
    redraws++;
  };
  const failure = () => {
    failures++;
  };
  const cache = new GpuPortraitCache(
    gl as unknown as WebGL2RenderingContext,
    redraw,
    failure,
  );
  t.after(() => cache.destroy());
  const pending = () => images.filter((image) => image.src && image.onload);
  const complete = (image: FakeImage) => image.onload?.();
  const failAll = (limit: number) => {
    let failures = 0;
    for (;;) {
      const active = pending();
      if (!active.length) break;
      assert.ok(active.length <= 6);
      assert.ok(
        ++failures <= limit,
        "failed portraits must not immediately restart",
      );
      active[0].onerror?.();
    }
    return failures;
  };
  const drain = () => {
    let peak = 0;
    for (;;) {
      const active = pending();
      if (!active.length) break;
      peak = Math.max(peak, active.length);
      assert.ok(active.length <= 6);
      complete(active[0]);
    }
    return peak;
  };
  return {
    gl,
    cache,
    images,
    pending,
    complete,
    failAll,
    drain,
    uploads,
    storage,
    deleted,
    mipmaps,
    redraw,
    failure,
    redraws: () => redraws,
    failures: () => failures,
    textureCount: () => textureCount,
  };
}

test("3313 tiny portraits fit the same two textures with at most six loaders", (t) => {
  const f = fixture(t),
    all = photos(3313),
    bytes = f.cache.bytes;
  f.cache.update(f.redraw, f.failure, new Set(all));
  f.cache.request(all, 0.1);
  assert.equal(f.cache.ready(), false);
  assert.equal(f.drain(), 6);
  assert.equal(f.cache.ready(), true);
  const tiles = all.map((photo) => f.cache.get(photo)!);
  assert.ok(
    tiles.every((tile) => tile && tile.gray && tile.uv[2] === 28 / 2048),
  );
  assert.equal(new Set(tiles.map((tile) => tile.uv.join(","))).size, 3313);
  assert.ok(
    tiles.every(
      (tile) =>
        tile.uv[0] >= 0 &&
        tile.uv[1] >= 0 &&
        tile.uv[0] + tile.uv[2] <= 1 &&
        tile.uv[1] + tile.uv[3] <= 1,
    ),
  );
  assert.equal(f.uploads.length, 3313);
  assert.ok(f.uploads.every((upload) => upload.size === 32));
  f.cache.prepare();
  assert.equal(f.mipmaps.length, 1);
  f.cache.prepare();
  assert.equal(f.mipmaps.length, 1);
  assert.equal(f.textureCount(), 2);
  assert.deepEqual(f.storage, [
    [1, 12, 2, 2048, 2048],
    [1, 12, 3, 2048, 2048],
  ]);
  assert.equal(f.cache.bytes, bytes);
  assert.equal(f.failures(), 0);
});

test("failed allocation of the second atlas deletes the first texture only", (t) => {
  const f = fixture(t);
  const allocated = { id: "partial-atlas" };
  let calls = 0;
  t.mock.method(f.gl, "createTexture", () =>
    ++calls === 1 ? allocated : null,
  );
  assert.throws(
    () =>
      new GpuPortraitCache(
        f.gl as unknown as WebGL2RenderingContext,
        f.redraw,
        f.failure,
      ),
    /GPU texture allocation failed/,
  );
  assert.equal(calls, 2);
  assert.deepEqual(f.deleted, [allocated]);
  assert.equal(f.failures(), 0);
  assert.equal(f.redraws(), 0);
  // Other caches sharing this GL context retain their own resources.
  f.cache.request(photos(1), 0.1);
  f.drain();
  assert.ok(f.cache.get(photos(1)[0]));
  assert.deepEqual(f.deleted, [allocated]);
});

test("second atlas initialization failure releases both newly allocated textures", (t) => {
  const f = fixture(t),
    allocated: object[] = [];
  const create = f.gl.createTexture;
  t.mock.method(f.gl, "createTexture", () => {
    const texture = create();
    assert.ok(texture);
    allocated.push(texture);
    return texture;
  });
  const failure = new Error("Atlas storage unavailable");
  let calls = 0;
  t.mock.method(f.gl, "texStorage2D", () => {
    if (++calls === 2) throw failure;
  });
  assert.throws(
    () =>
      new GpuPortraitCache(
        f.gl as unknown as WebGL2RenderingContext,
        f.redraw,
        f.failure,
      ),
    (error) => error === failure,
  );
  assert.equal(allocated.length, 2);
  assert.deepEqual(f.deleted, allocated);
  assert.equal(f.failures(), 0);
  assert.equal(f.redraws(), 0);
});

test("1521 photos retain 48px packing, and only larger projections repack", (t) => {
  const f = fixture(t),
    all = photos(1522);
  f.cache.update(f.redraw, f.failure, new Set(all.slice(0, 1521)));
  f.cache.request([all[0]], 0.1);
  f.drain();
  assert.equal(f.cache.get(all[0])?.uv[2], 48 / 2048);
  const originalTexture = f.cache.get(all[0])?.texture;
  f.cache.update(f.redraw, f.failure, new Set(all));
  f.cache.request([all[0]], 0.1);
  f.drain();
  assert.equal(f.cache.get(all[0])?.uv[2], 28 / 2048);
  assert.equal(f.cache.get(all[0])?.texture, originalTexture);
});

test("small projections retain 48px tiles and zoom never blanks resident portraits", (t) => {
  const f = fixture(t),
    all = photos(30);
  f.cache.update(f.redraw, f.failure, new Set(all));
  f.cache.request(all, 0.1);
  f.drain();
  const initial = all.map((photo) => f.cache.get(photo));
  assert.ok(initial.every((tile) => tile?.uv[2] === 48 / 2048));
  const tinyUploads = f.uploads.length;
  f.cache.request(all, 0.5);
  assert.deepEqual(
    all.map((photo) => f.cache.get(photo)),
    initial,
  );
  f.drain();
  assert.equal(f.uploads.length, tinyUploads + all.length);
  assert.ok(all.every((photo) => !f.cache.get(photo)?.gray));
  f.cache.request(all, 0.1);
  assert.deepEqual(
    all.map((photo) => f.cache.get(photo)),
    initial,
  );
  assert.equal(f.pending().length, 0);
  assert.equal(f.uploads.length, tinyUploads + all.length);
});

test("expansion invalidates pending tiny UVs, preserves thumbs, and never contracts", (t) => {
  const f = fixture(t),
    all = photos(3313);
  f.cache.update(f.redraw, f.failure, new Set(all.slice(0, 2)));
  f.cache.request(all.slice(0, 2), 0.5);
  f.drain();
  const thumb = f.cache.get(all[0]);
  f.cache.request(all.slice(0, 12), 0.1);
  const staleImage = f.pending()[0],
    staleLoad = staleImage.onload!,
    staleError = staleImage.onerror!;
  const beforeUploads = f.uploads.length,
    beforeRedraws = f.redraws();
  f.cache.update(f.redraw, f.failure, new Set(all));
  assert.equal(staleImage.src, "");
  assert.equal(staleImage.onload, null);
  staleLoad();
  staleError();
  assert.equal(f.uploads.length, beforeUploads);
  assert.ok(f.redraws() > beforeRedraws);
  // During repacking, low zoom can keep an already resident high-quality image.
  assert.deepEqual(f.cache.get(all[0]), thumb);
  f.cache.request(all, 0.1);
  f.drain();
  assert.ok(all.every((photo) => f.cache.get(photo)?.uv[2] === 28 / 2048));
  f.cache.update(f.redraw, f.failure, new Set([all[0]]));
  const retained = f.cache.get(all[0]);
  f.cache.request([all[0]], 0.1);
  assert.deepEqual(f.cache.get(all[0]), retained);
  assert.equal(f.cache.get(all[1]), undefined);
  assert.equal(f.pending().length, 0);
  assert.equal(f.textureCount(), 2);
  assert.equal(f.storage.length, 2);
});

test("revocation and destroy cancel loaders including late callbacks and release both pages", (t) => {
  const f = fixture(t),
    all = photos(10);
  f.cache.request(all, 0.1);
  f.complete(f.pending()[0]);
  const revoked = f.pending()[0],
    lateLoad = revoked.onload!,
    lateError = revoked.onerror!;
  const uploaded = f.uploads.length;
  f.cache.update(f.redraw, f.failure, new Set([all[0]]));
  assert.equal(f.pending().length, 0);
  assert.equal(revoked.src, "");
  lateLoad();
  lateError();
  assert.equal(f.uploads.length, uploaded);
  assert.equal(f.cache.get(all[1]), undefined);
  assert.ok(f.cache.get(all[0]));
  f.cache.request(all, 0.5);
  const pending = f
    .pending()
    .map((image) => ({ image, load: image.onload!, error: image.onerror! }));
  f.cache.destroy();
  for (const { image, load, error } of pending) {
    assert.equal(image.src, "");
    assert.equal(image.onload, null);
    load();
    error();
  }
  f.cache.request(all, 0.1);
  f.cache.update(f.redraw, f.failure, new Set(all));
  assert.equal(f.pending().length, 0);
  assert.equal(f.cache.get(all[0]), undefined);
  assert.equal(f.uploads.length, uploaded);
  assert.equal(f.deleted.length, 2);
  f.cache.destroy();
  assert.equal(f.deleted.length, 2);
});

test("packing expands through 20px and caps at 10404 slots without exceeding memory", (t) => {
  const f = fixture(t);
  for (const [count, size] of [
    [4097, 20],
    [7226, 16],
    [11000, 16],
  ]) {
    const all = photos(count);
    f.cache.update(f.redraw, f.failure, new Set(all));
    f.cache.request(all, 0.1);
    f.complete(f.pending()[0]);
    assert.equal(f.cache.get(all[0])?.uv[2], size / 2048);
  }
  f.drain();
  const all = photos(11000);
  assert.equal(all.filter((photo) => f.cache.get(photo)).length, 10404);
  assert.equal(f.cache.get(all[10404]), undefined);
  assert.equal(f.cache.ready(), true);
  assert.equal(f.textureCount(), 2);
  assert.equal(f.storage.length, 2);
});

test("all 3313 unavailable portraits settle and retry only after the failure TTL", (t) => {
  const f = fixture(t),
    all = photos(3313);
  let now = 1000;
  t.mock.method(Date, "now", () => now);
  f.cache.update(f.redraw, f.failure, new Set(all));
  f.cache.request(all, 0.1);
  assert.equal(f.failAll(all.length), all.length);
  assert.equal(f.images.length, all.length);
  assert.equal(f.cache.ready(), true);
  now += 29_999;
  f.cache.request(all, 0.1);
  assert.equal(f.images.length, all.length);
  assert.equal(f.cache.ready(), true);
  now++;
  assert.equal(f.cache.ready(), false);
  f.cache.request(all, 0.1);
  assert.equal(f.pending().length, 6);
  f.drain();
  assert.equal(f.images.length, all.length * 2);
  assert.ok(all.every((photo) => f.cache.get(photo)));
  assert.equal(f.cache.ready(), true);
  const loaded = f.images.length;
  f.cache.request(all, 0.1);
  assert.equal(f.images.length, loaded);
});

test("failure history stays bounded across viewports without evicting current failures", (t) => {
  const f = fixture(t),
    all = photos(12000);
  t.mock.method(Date, "now", () => 1000);
  for (let start = 0; start < all.length; start += 3000) {
    const visible = all.slice(start, start + 3000);
    f.cache.request(visible, 0.1);
    assert.equal(f.failAll(visible.length), visible.length);
    assert.equal(f.cache.ready(), true);
  }
  assert.equal(f.images.length, all.length);
  const recent = all.slice(9000);
  f.cache.request(recent, 0.1);
  assert.equal(f.images.length, all.length);
  // The oldest inactive viewport was evicted to make room, not the current one.
  f.cache.request([all[0]], 0.1);
  assert.equal(f.images.length, all.length + 1);
  f.failAll(1);
  f.cache.request(recent, 0.1);
  assert.equal(f.images.length, all.length + 1);
});

test("queue preserves requested priority across out-of-order completions and cancellation", (t) => {
  const f = fixture(t),
    all = photos(12);
  f.cache.request(all, 0.1);
  assert.deepEqual(
    f.pending().map((image) => image.src),
    all.slice(0, 6).map((photo) => `${photo}?variant=tiny`),
  );
  const stale = f.pending()[0],
    lateLoad = stale.onload!,
    lateError = stale.onerror!;
  f.complete(f.pending()[4]);
  assert.equal(f.images[6].src, `${all[6]}?variant=tiny`);
  f.cache.request(all, 0.1);
  assert.equal(f.images.length, 7);
  const reversed = [...all].reverse();
  f.cache.request(reversed, 0.1);
  f.complete(f.pending()[1]);
  assert.equal(f.images[7].src, `${all[11]}?variant=tiny`);
  f.cache.request([all[10]], 0.1);
  assert.equal(stale.src, "");
  const uploads = f.uploads.length;
  lateLoad();
  lateError();
  assert.equal(f.uploads.length, uploads);
  assert.equal(f.pending().length, 1);
  f.drain();
  assert.equal(f.cache.ready(), true);
  assert.ok(f.cache.get(all[10]));
});
