import { CanvasTexture, LinearFilter, SRGBColorSpace } from "three";
import { safeUrl } from "../../domain/dates.ts";
import type { Person } from "../../domain/types.ts";
import { mediaPreview } from "../../domain/media-preview.ts";
import { portraitLoadTimeoutMs } from "../portrait-retry.ts";

export const SPATIAL_ATLAS_SIDE = 2048;
export function spatialPortraitTile(people: number) {
  return people <= 256 ? 128 : people <= 1024 ? 64 : people <= 4096 ? 32 : 16;
}
export type SpatialPalette = {
  paper: string;
  ink: string;
  muted: string;
  green: string;
  red: string;
};

/** Fixed 16 MiB RGBA portrait page without mipmaps. At most four decoded portraits
 * are in flight; revoked images are cancelled and never form an unbounded cache. */
export class SpatialCardAtlas {
  readonly canvas = document.createElement("canvas");
  readonly texture: CanvasTexture;
  readonly tile: number;
  readonly columns: number;
  readonly capacity: number;
  private context: CanvasRenderingContext2D;
  private slots = new Map<string, { slot: number; person: Person }>();
  private pending = new Map<
    string,
    { image: HTMLImageElement; timer: ReturnType<typeof setTimeout> }
  >();
  private settled = new Set<string>();
  private stopped = false;
  private palette: SpatialPalette;
  private invalidate: () => void;
  constructor(
    palette: SpatialPalette,
    invalidate: () => void,
    peopleCount: number,
  ) {
    this.palette = palette;
    this.invalidate = invalidate;
    this.tile = spatialPortraitTile(peopleCount);
    this.columns = SPATIAL_ATLAS_SIDE / this.tile;
    this.capacity = this.columns ** 2;
    this.canvas.width = this.canvas.height = SPATIAL_ATLAS_SIDE;
    this.context = this.canvas.getContext("2d")!;
    this.texture = new CanvasTexture(this.canvas);
    this.texture.colorSpace = SRGBColorSpace;
    this.texture.generateMipmaps = false;
    this.texture.minFilter = this.texture.magFilter = LinearFilter;
  }
  update(people: Person[]) {
    const selected = people.slice(0, this.capacity);
    const wanted = new Set(selected.map((p) => p.id));
    for (const [id, load] of this.pending)
      if (!wanted.has(id)) {
        clearTimeout(load.timer);
        load.image.onload = load.image.onerror = null;
        load.image.src = "";
        this.pending.delete(id);
      }
    for (const id of this.slots.keys())
      if (!wanted.has(id)) {
        this.slots.delete(id);
        this.settled.delete(id);
      }
    const used = new Set([...this.slots.values()].map((s) => s.slot));
    let nextFree = 0;
    for (const person of selected) {
      const old = this.slots.get(person.id);
      if (old && old.person === person) continue;
      if (
        old &&
        old.person.photo === person.photo &&
        old.person.name === person.name &&
        old.person.surname === person.surname
      ) {
        old.person = person;
        continue;
      }
      let slot = old?.slot ?? nextFree;
      while (!old && used.has(slot)) slot++;
      if (slot >= this.capacity) break;
      if (!old) nextFree = slot + 1;
      if (old) {
        const load = this.pending.get(person.id);
        if (load) {
          clearTimeout(load.timer);
          load.image.onload = load.image.onerror = null;
          load.image.src = "";
          this.pending.delete(person.id);
        }
      }
      this.slots.set(person.id, { slot, person });
      used.add(slot);
      this.settled.delete(person.id);
      this.draw(person.id);
    }
    this.pump();
  }
  uv(id: string) {
    const slot = this.slots.get(id)!.slot;
    return [
      (slot % this.columns) / this.columns,
      1 - (Math.floor(slot / this.columns) + 1) / this.columns,
      1 / this.columns,
      1 / this.columns,
    ];
  }
  private draw(id: string, image?: HTMLImageElement) {
    const tile = this.slots.get(id);
    if (!tile || this.stopped) return;
    const c = this.context,
      x = (tile.slot % this.columns) * this.tile,
      y = Math.floor(tile.slot / this.columns) * this.tile;
    c.clearRect(x, y, this.tile, this.tile);
    c.save();
    c.translate(x, y);
    c.scale(this.tile / 256, this.tile / 256);
    c.save();
    c.beginPath();
    c.arc(128, 128, 124, 0, Math.PI * 2);
    c.clip();
    c.fillStyle = this.palette.green;
    c.globalAlpha = 0.12;
    c.fillRect(0, 0, 256, 256);
    c.globalAlpha = 1;
    if (image) {
      const side = Math.min(image.naturalWidth, image.naturalHeight);
      c.drawImage(
        image,
        (image.naturalWidth - side) / 2,
        (image.naturalHeight - side) / 2,
        side,
        side,
        0,
        0,
        256,
        256,
      );
    } else {
      c.fillStyle = this.palette.green;
      c.font = "500 76px sans-serif";
      c.textAlign = "center";
      c.fillText(
        [tile.person.name[0], tile.person.surname[0]].filter(Boolean).join(""),
        128,
        153,
      );
    }
    c.restore();
    c.restore();
    this.texture.needsUpdate = true;
    this.invalidate();
  }
  private pump() {
    if (this.stopped) return;
    for (const [id, { person }] of this.slots) {
      if (this.pending.size >= 4) break;
      if (this.pending.has(id) || this.settled.has(id)) continue;
      const src = mediaPreview(safeUrl(person.photo), "thumb");
      if (!src) {
        this.settled.add(id);
        continue;
      }
      const image = new Image();
      image.crossOrigin = "anonymous";
      const finish = (ok: boolean) => {
        const load = this.pending.get(id);
        if (!load || load.image !== image) return;
        clearTimeout(load.timer);
        image.onload = image.onerror = null;
        this.pending.delete(id);
        this.settled.add(id);
        if (ok && image.naturalWidth) this.draw(id, image);
        image.src = "";
        this.pump();
      };
      this.pending.set(id, {
        image,
        timer: setTimeout(() => finish(false), portraitLoadTimeoutMs),
      });
      image.onload = () => finish(true);
      image.onerror = () => finish(false);
      image.src = src;
    }
  }
  dispose() {
    this.stopped = true;
    for (const { image, timer } of this.pending.values()) {
      clearTimeout(timer);
      image.onload = image.onerror = null;
      image.src = "";
    }
    this.pending.clear();
    this.slots.clear();
    this.settled.clear();
    this.texture.dispose();
    this.canvas.width = this.canvas.height = 1;
  }
}
