import { mediaPreview } from "../../domain/media-preview.ts";
import { safeUrl } from "../../domain/index.ts";
import { mayRetryPortrait, portraitLoadTimeoutMs, portraitRetryDelays, retryPortraitUrl, waitForPortraitRetry } from "../portrait-retry.ts";

type Tile = { slot: number; touched: number };
export type PortraitTile = {
  texture: WebGLTexture;
  uv: number[];
  gray: boolean;
};
const SIZE = 2048;
const TINY_SIZES = [48, 28, 20, 16];
const capacityFor = (size: number) => Math.floor(SIZE / (size + 4)) ** 2;
const MAX_FAILURES = capacityFor(16) + capacityFor(264);
const RETRY_MS = 30_000;

/** Two fixed pages within a 32 MiB budget, no archive-sized decoded-image cache. */
export class GpuPortraitCache {
  private pages: {
    texture: WebGLTexture;
    cell: number;
    size: number;
    tiles: Map<string, Tile>;
    free: number[];
    dirty: boolean;
  }[];
  private loading = new Map<string, HTMLImageElement>();
  private loadDeadlines = new Map<string, ReturnType<typeof setTimeout>>();
  private failed = new Map<string, number>();
  private retries = new Map<string, number>();
  private recovering = new Map<string, AbortController>();
  private wanted: { key: string; photo: string; level: number }[] = [];
  private wantedKeys = new Set<string>();
  private nextWanted = 0;
  private clock = 0;
  private stopped = false;
  private highQuality = false;
  private scratch = document.createElement("canvas");
  private gl: WebGL2RenderingContext;
  private redraw: () => void;
  private failure: () => void;
  readonly bytes = Math.ceil((SIZE * SIZE * 5 * 4) / 3);

  constructor(
    gl: WebGL2RenderingContext,
    redraw: () => void,
    failure: () => void,
  ) {
    this.gl = gl;
    this.redraw = redraw;
    this.failure = failure;
    const allocated: WebGLTexture[] = [];
    try {
      this.pages = [48, 264].map((size) => {
        const texture = gl.createTexture();
        if (!texture) throw new Error("GPU texture allocation failed");
        allocated.push(texture);
        gl.bindTexture(gl.TEXTURE_2D, texture);
        gl.texStorage2D(
          gl.TEXTURE_2D,
          12,
          size === 48 ? gl.R8 : gl.RGBA8,
          SIZE,
          SIZE,
        );
        gl.texParameteri(
          gl.TEXTURE_2D,
          gl.TEXTURE_MIN_FILTER,
          gl.LINEAR_MIPMAP_LINEAR,
        );
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
        const cell = size + 4,
          capacity = Math.floor(SIZE / cell) ** 2;
        return {
          texture,
          cell,
          size,
          tiles: new Map<string, Tile>(),
          dirty: false,
          free: Array.from(
            { length: capacity },
            (_, index) => capacity - index - 1,
          ),
        };
      });
    } catch (error) {
      for (const texture of allocated) gl.deleteTexture(texture);
      throw error;
    }
  }

  static supported(photo?: string) {
    return (
      !photo ||
      /^\/media\/[\w-]+\.(jpg|png|webp)$/.test(photo) ||
      /^\/api\/shared\/[\w-]{43}\/portrait\/[^/?#]+$/.test(photo)
    );
  }

  update(redraw: () => void, failure: () => void, photos: ReadonlySet<string>) {
    if (this.stopped) return;
    this.redraw = redraw;
    this.failure = failure;
    this.expandTiny(photos.size);
    for (const page of this.pages)
      for (const [photo, tile] of page.tiles)
        if (!photos.has(photo)) {
          page.tiles.delete(photo);
          page.free.push(tile.slot);
        }
    this.setWanted(this.wanted.filter((item) => photos.has(item.photo)));
    for (const [key, image] of this.loading)
      if (!photos.has(key.slice(2))) {
        this.clearLoadDeadline(key);
        image.onload = image.onerror = null;
        image.src = "";
        this.loading.delete(key);
      }
    for (const key of this.failed.keys())
      if (!photos.has(key.slice(2))) this.failed.delete(key);
    for (const key of this.retries.keys())
      if (!photos.has(key.slice(2))) this.retries.delete(key);
    for (const [key, controller] of this.recovering)
      if (!photos.has(key.slice(2))) {
        controller.abort();
        this.recovering.delete(key);
      }
    this.pump();
  }

  request(photos: string[], zoom: number) {
    if (this.stopped) return;
    this.highQuality = this.quality(zoom);
    const unique = [...new Set(photos)];
    this.expandTiny(unique.length);
    // High resolution only for the nearest 49 visible portraits. Tiny tiles stay
    // resident during upgrades; camera motion never blanks an existing portrait.
    const wanted = unique
      .slice(0, capacityFor(this.pages[0].size))
      .map((photo) => ({
        key: `0:${photo}`,
        photo,
        level: 0,
      }));
    if (this.highQuality)
      wanted.unshift(
        ...unique.slice(0, 49).map((photo) => ({
          key: `1:${photo}`,
          photo,
          level: 1,
        })),
      );
    this.setWanted(wanted);
    const now = Date.now();
    for (const [key, failedAt] of this.failed)
      if (this.wantedKeys.has(key) && now - failedAt >= RETRY_MS) {
        this.nextWanted = 0;
        break;
      }
    for (const item of this.wanted) {
      const tile = this.pages[item.level].tiles.get(item.photo);
      if (tile) tile.touched = ++this.clock;
    }
    for (const [key, image] of this.loading)
      if (!this.wantedKeys.has(key)) {
        this.clearLoadDeadline(key);
        image.onload = image.onerror = null;
        image.src = "";
        this.loading.delete(key);
      }
    for (const [key, controller] of this.recovering)
      if (!this.wantedKeys.has(key)) {
        controller.abort();
        this.recovering.delete(key);
        this.failed.delete(key);
        this.retries.delete(key);
      }
    this.pump();
  }

  quality(zoom: number) {
    return zoom > 0.34 || (this.highQuality && zoom >= 0.26);
  }

  ready() {
    const now = Date.now();
    return this.wanted.every(
      (item) =>
        this.pages[item.level].tiles.has(item.photo) ||
        (this.failed.has(item.key) &&
          now - this.failed.get(item.key)! < RETRY_MS),
    );
  }

  private setWanted(wanted: typeof this.wanted) {
    if (
      wanted.length === this.wanted.length &&
      wanted.every((item, index) => item.key === this.wanted[index].key)
    )
      return;
    this.wanted = wanted;
    this.wantedKeys = new Set(wanted.map((item) => item.key));
    this.nextWanted = 0;
  }

  prepare() {
    for (const page of this.pages)
      if (page.dirty) {
        this.gl.bindTexture(this.gl.TEXTURE_2D, page.texture);
        this.gl.generateMipmap(this.gl.TEXTURE_2D);
        page.dirty = false;
      }
  }

  get(photo: string): PortraitTile | undefined {
    for (const level of this.highQuality ? [1, 0] : [0, 1]) {
      const page = this.pages[level],
        tile = page.tiles.get(photo);
      if (!tile) continue;
      const columns = Math.floor(SIZE / page.cell);
      return {
        texture: page.texture,
        gray: level === 0,
        uv: [
          ((tile.slot % columns) * page.cell + 2) / SIZE,
          (Math.floor(tile.slot / columns) * page.cell + 2) / SIZE,
          page.size / SIZE,
          page.size / SIZE,
        ],
      };
    }
  }

  private expandTiny(photoCount: number) {
    const page = this.pages[0];
    if (photoCount <= capacityFor(page.size)) return;
    const size =
      TINY_SIZES.find((value) => capacityFor(value) >= photoCount) ??
      TINY_SIZES[TINY_SIZES.length - 1];
    if (size >= page.size) return;
    // Reuse immutable R8 storage. Old tiny UVs become invalid together, and
    // pending callbacks cannot insert a tile using the previous packing.
    for (const [key, image] of this.loading)
      if (key.startsWith("0:")) {
        this.clearLoadDeadline(key);
        image.onload = image.onerror = null;
        image.src = "";
        this.loading.delete(key);
      }
    page.size = size;
    page.cell = size + 4;
    page.tiles.clear();
    this.nextWanted = 0;
    const capacity = capacityFor(size);
    page.free = Array.from(
      { length: capacity },
      (_, index) => capacity - index - 1,
    );
    page.dirty = true;
    this.redraw();
  }

  private clearLoadDeadline(key: string) {
    const deadline = this.loadDeadlines.get(key);
    if (deadline !== undefined) clearTimeout(deadline);
    this.loadDeadlines.delete(key);
  }

  private pump() {
    if (this.stopped) return;
    while (this.nextWanted < this.wanted.length && this.loading.size + this.recovering.size < 6) {
      const item = this.wanted[this.nextWanted++];
      const page = this.pages[item.level];
      if (
        page.tiles.has(item.photo) ||
        this.loading.has(item.key) ||
        this.recovering.has(item.key) ||
        (this.failed.has(item.key) &&
          Date.now() - this.failed.get(item.key)! < RETRY_MS)
      )
        continue;
      const image = new Image();
      this.loading.set(item.key, image);
      image.onload = () => {
        if (this.stopped || this.loading.get(item.key) !== image) return;
        this.clearLoadDeadline(item.key);
        this.loading.delete(item.key);
        try {
          const columns = Math.floor(SIZE / page.cell);
          let slot = page.free.pop();
          if (slot === undefined) {
            let oldest: [string, Tile] | undefined;
            for (const entry of page.tiles)
              if (!oldest || entry[1].touched < oldest[1].touched)
                oldest = entry;
            slot = oldest![1].slot;
            page.tiles.delete(oldest![0]);
          }
          this.scratch.width = this.scratch.height = page.cell;
          const ctx = this.scratch.getContext("2d")!;
          const scale = Math.max(
            page.size / image.naturalWidth,
            page.size / image.naturalHeight,
          );
          ctx.drawImage(
            image,
            2 + (page.size - image.naturalWidth * scale) / 2,
            2 + (page.size - image.naturalHeight * scale) / 2,
            image.naturalWidth * scale,
            image.naturalHeight * scale,
          );
          const gl = this.gl;
          gl.bindTexture(gl.TEXTURE_2D, page.texture);
          if (item.level === 0) {
            const rgba = ctx.getImageData(0, 0, page.cell, page.cell).data;
            const gray = new Uint8Array(page.cell * page.cell);
            for (let i = 0; i < gray.length; i++)
              gray[i] = Math.round(
                rgba[i * 4] * 0.2126 +
                  rgba[i * 4 + 1] * 0.7152 +
                  rgba[i * 4 + 2] * 0.0722,
              );
            gl.texSubImage2D(
              gl.TEXTURE_2D,
              0,
              (slot % columns) * page.cell,
              Math.floor(slot / columns) * page.cell,
              page.cell,
              page.cell,
              gl.RED,
              gl.UNSIGNED_BYTE,
              gray,
            );
          } else
            gl.texSubImage2D(
              gl.TEXTURE_2D,
              0,
              (slot % columns) * page.cell,
              Math.floor(slot / columns) * page.cell,
              gl.RGBA,
              gl.UNSIGNED_BYTE,
              this.scratch,
            );
          page.dirty = true;
          page.tiles.set(item.photo, { slot, touched: ++this.clock });
          this.failed.delete(item.key);
          this.retries.delete(item.key);
          this.redraw();
        } catch {
          this.failure();
        }
        image.onload = image.onerror = null;
        this.pump();
      };
      image.onerror = () => {
        if (this.stopped || this.loading.get(item.key) !== image) return;
        this.clearLoadDeadline(item.key);
        this.loading.delete(item.key);
        const attempt = this.retries.get(item.key) || 0;
        this.failed.set(item.key, attempt >= portraitRetryDelays.length ? Infinity : Date.now());
        // Keep failures for the entire active packing, including all-404 trees.
        // Historical viewport failures may be evicted, active ones retain TTL.
        for (const key of this.failed.keys()) {
          if (this.failed.size <= MAX_FAILURES) break;
          if (!this.wantedKeys.has(key)) this.failed.delete(key);
        }
        image.onload = image.onerror = null;
        this.redraw();
        if (attempt >= portraitRetryDelays.length) {
          this.pump();
          return;
        }
        const controller = new AbortController();
        this.recovering.set(item.key, controller);
        this.pump();
        void (async () => {
          await waitForPortraitRetry(portraitRetryDelays[attempt], controller.signal);
          if (controller.signal.aborted) return;
          const url = mediaPreview(safeUrl(item.photo), item.level ? "thumb" : "tiny")!;
          const retry = await mayRetryPortrait(url, controller.signal);
          if (controller.signal.aborted || this.stopped || !this.wantedKeys.has(item.key)) return;
          if (retry) {
            this.retries.set(item.key, attempt + 1);
            this.failed.delete(item.key);
            this.nextWanted = 0;
          } else this.failed.set(item.key, Infinity);
        })().finally(() => {
          if (this.recovering.get(item.key) === controller) {
            this.recovering.delete(item.key);
            this.pump();
          }
        });
      };
      this.loadDeadlines.set(item.key, setTimeout(() => {
        if (this.stopped || this.loading.get(item.key) !== image) return;
        image.onerror?.(new Event("error"));
        image.src = "";
      }, portraitLoadTimeoutMs));
      image.src = retryPortraitUrl(mediaPreview(
        safeUrl(item.photo),
        item.level ? "thumb" : "tiny",
      )!, this.retries.get(item.key) || 0);
    }
  }

  destroy() {
    if (this.stopped) return;
    this.stopped = true;
    for (const image of this.loading.values()) {
      image.onload = image.onerror = null;
      image.src = "";
    }
    for (const deadline of this.loadDeadlines.values()) clearTimeout(deadline);
    this.loadDeadlines.clear();
    this.loading.clear();
    this.wanted = [];
    this.wantedKeys.clear();
    this.nextWanted = 0;
    this.failed.clear();
    this.retries.clear();
    for (const controller of this.recovering.values()) controller.abort();
    this.recovering.clear();
    for (const page of this.pages) {
      this.gl.deleteTexture(page.texture);
      page.tiles.clear();
    }
    this.scratch.width = this.scratch.height = 1;
  }
}
