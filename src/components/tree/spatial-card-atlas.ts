import { CanvasTexture, LinearFilter, SRGBColorSpace } from "three";
import { safeUrl, years, type Person } from "../../domain";
import { mediaPreview } from "../../domain/media-preview";
import { portraitLoadTimeoutMs } from "../portrait-retry";

const TILE = 256,
  COLUMNS = 4,
  ROWS = 8;
export const SPATIAL_ATLAS_CAPACITY = COLUMNS * ROWS;
export type SpatialPalette = {
  paper: string;
  ink: string;
  muted: string;
  green: string;
  red: string;
};

/** Fixed 8 MiB RGBA page without mipmaps. At most four decoded portraits are
 * in flight; offscreen images are cancelled and never form an unbounded cache. */
export class SpatialCardAtlas {
  readonly canvas = document.createElement("canvas");
  readonly texture: CanvasTexture;
  private context: CanvasRenderingContext2D;
  private slots = new Map<string, { slot: number; person: Person }>();
  private pending = new Map<
    string,
    { image: HTMLImageElement; timer: ReturnType<typeof setTimeout> }
  >();
  private settled = new Set<string>();
  private stopped = false;
  constructor(
    private palette: SpatialPalette,
    private invalidate: () => void,
  ) {
    this.canvas.width = TILE * COLUMNS;
    this.canvas.height = TILE * ROWS;
    this.context = this.canvas.getContext("2d")!;
    this.texture = new CanvasTexture(this.canvas);
    this.texture.colorSpace = SRGBColorSpace;
    this.texture.generateMipmaps = false;
    this.texture.minFilter = this.texture.magFilter = LinearFilter;
  }
  update(people: Person[]) {
    const wanted = new Set(people.map((p) => p.id));
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
    for (const person of people.slice(0, SPATIAL_ATLAS_CAPACITY)) {
      const old = this.slots.get(person.id);
      if (old && old.person === person) continue;
      let slot = old?.slot ?? 0;
      while (!old && used.has(slot)) slot++;
      if (slot >= SPATIAL_ATLAS_CAPACITY) break;
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
      (slot % COLUMNS) / COLUMNS,
      1 - (Math.floor(slot / COLUMNS) + 1) / ROWS,
      1 / COLUMNS,
      1 / ROWS,
    ];
  }
  private draw(id: string, image?: HTMLImageElement) {
    const tile = this.slots.get(id);
    if (!tile || this.stopped) return;
    const c = this.context,
      x = (tile.slot % COLUMNS) * TILE,
      y = Math.floor(tile.slot / COLUMNS) * TILE;
    c.clearRect(x, y, TILE, TILE);
    c.save();
    c.translate(x, y);
    c.fillStyle = this.palette.paper;
    c.beginPath();
    c.roundRect(6, 3, 244, 250, 14);
    c.fill();
    c.save();
    c.beginPath();
    c.arc(128, 69, 51, 0, Math.PI * 2);
    c.clip();
    c.fillStyle = this.palette.green;
    c.globalAlpha = 0.12;
    c.fillRect(77, 18, 102, 102);
    c.globalAlpha = 1;
    if (image) {
      const side = Math.min(image.naturalWidth, image.naturalHeight);
      c.drawImage(
        image,
        (image.naturalWidth - side) / 2,
        (image.naturalHeight - side) / 2,
        side,
        side,
        77,
        18,
        102,
        102,
      );
    } else {
      c.fillStyle = this.palette.green;
      c.font = "500 30px sans-serif";
      c.textAlign = "center";
      c.fillText(
        [tile.person.name[0], tile.person.surname[0]].filter(Boolean).join(""),
        128,
        80,
      );
    }
    c.restore();
    c.textAlign = "center";
    const text = (value: string, y: number, font: string, color: string) => {
      c.font = font;
      c.fillStyle = color;
      let label = value;
      while (label.length && c.measureText(label).width > 228)
        label = label.slice(0, -1);
      c.fillText(label === value ? label : `${label.slice(0, -1)}…`, 128, y);
    };
    text(
      tile.person.surname || tile.person.name,
      151,
      "600 23px sans-serif",
      this.palette.ink,
    );
    text(
      tile.person.surname ? tile.person.name : "",
      180,
      "21px sans-serif",
      this.palette.ink,
    );
    text(
      tile.person.patronymic || "",
      205,
      "19px sans-serif",
      this.palette.ink,
    );
    text(years(tile.person), 236, "19px sans-serif", this.palette.muted);
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
