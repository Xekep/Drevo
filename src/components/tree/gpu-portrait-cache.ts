import { mediaPreview } from "../../domain/media-preview";
import { safeUrl } from "../../domain";

type Tile = { slot: number; touched: number };
export type PortraitTile = {
  texture: WebGLTexture;
  uv: number[];
  gray: boolean;
};
const SIZE = 2048;

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
  private failed = new Map<string, number>();
  private wanted: { key: string; photo: string; level: number }[] = [];
  private clock = 0;
  private stopped = false;
  private highQuality = false;
  private scratch = document.createElement("canvas");
  readonly bytes = Math.ceil((SIZE * SIZE * 5 * 4) / 3);

  constructor(
    private gl: WebGL2RenderingContext,
    private redraw: () => void,
    private failure: () => void,
  ) {
    this.pages = [48, 264].map((size) => {
      const texture = gl.createTexture();
      if (!texture) throw new Error("GPU texture allocation failed");
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
  }

  static supported(photo?: string) {
    return (
      !photo ||
      /^\/media\/[\w-]+\.(jpg|png|webp)$/.test(photo) ||
      /^\/api\/shared\/[\w-]{43}\/portrait\/[^/?#]+$/.test(photo)
    );
  }

  update(redraw: () => void, failure: () => void, photos: ReadonlySet<string>) {
    this.redraw = redraw;
    this.failure = failure;
    for (const page of this.pages)
      for (const [photo, tile] of page.tiles)
        if (!photos.has(photo)) {
          page.tiles.delete(photo);
          page.free.push(tile.slot);
        }
    this.wanted = this.wanted.filter((item) => photos.has(item.photo));
    for (const [key, image] of this.loading)
      if (!photos.has(key.slice(2))) {
        image.onload = image.onerror = null;
        image.src = "";
        this.loading.delete(key);
      }
  }

  request(photos: string[], zoom: number) {
    this.highQuality = this.quality(zoom);
    const unique = [...new Set(photos)];
    // High resolution only for the nearest 49 visible portraits. Tiny tiles stay
    // resident during upgrades; camera motion never blanks an existing portrait.
    this.wanted = unique.slice(0, 1521).map((photo) => ({
      key: `0:${photo}`,
      photo,
      level: 0,
    }));
    if (this.highQuality)
      this.wanted.unshift(
        ...unique.slice(0, 49).map((photo) => ({
          key: `1:${photo}`,
          photo,
          level: 1,
        })),
      );
    for (const item of this.wanted) {
      const tile = this.pages[item.level].tiles.get(item.photo);
      if (tile) tile.touched = ++this.clock;
    }
    const wanted = new Set(this.wanted.map((item) => item.key));
    for (const [key, image] of this.loading)
      if (!wanted.has(key)) {
        image.onload = image.onerror = null;
        image.src = "";
        this.loading.delete(key);
      }
    this.pump();
  }

  quality(zoom: number) {
    return zoom > 0.34 || (this.highQuality && zoom >= 0.26);
  }

  ready() {
    return this.wanted.every(
      (item) =>
        this.pages[item.level].tiles.has(item.photo) ||
        this.failed.has(item.key),
    );
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
    for (const level of this.highQuality ? [1, 0] : [0]) {
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

  private pump() {
    if (this.stopped) return;
    for (const item of this.wanted) {
      if (this.loading.size >= 6) break;
      const page = this.pages[item.level];
      if (
        page.tiles.has(item.photo) ||
        this.loading.has(item.key) ||
        (this.failed.has(item.key) &&
          Date.now() - this.failed.get(item.key)! < 30_000)
      )
        continue;
      const image = new Image();
      this.loading.set(item.key, image);
      image.onload = () => {
        if (this.stopped || this.loading.get(item.key) !== image) return;
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
          this.redraw();
        } catch {
          this.failure();
        }
        image.onload = image.onerror = null;
        this.pump();
      };
      image.onerror = () => {
        this.loading.delete(item.key);
        if (this.failed.size >= 2048) this.failed.clear();
        this.failed.set(item.key, Date.now());
        this.redraw();
        this.pump();
      };
      image.src = mediaPreview(
        safeUrl(item.photo),
        item.level ? "thumb" : "tiny",
      )!;
    }
  }

  destroy() {
    if (this.stopped) return;
    this.stopped = true;
    for (const image of this.loading.values()) {
      image.onload = image.onerror = null;
      image.src = "";
    }
    this.loading.clear();
    this.wanted = [];
    this.failed.clear();
    for (const page of this.pages) {
      this.gl.deleteTexture(page.texture);
      page.tiles.clear();
    }
    this.scratch.width = this.scratch.height = 1;
  }
}
