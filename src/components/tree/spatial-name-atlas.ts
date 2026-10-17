import { CanvasTexture, LinearFilter, SRGBColorSpace } from "three";
import { years } from "../../domain/dates.ts";
import type { Person } from "../../domain/types.ts";
import type { SpatialPalette } from "./spatial-card-atlas.ts";

export type SpatialGlyph = {
  tile: number[];
  layout: number[];
  date: number;
};

/** Names share glyph pixels rather than shrinking a whole person's text into
 * their portrait tile. The fixed 4 MiB texture stays sharp on large archives. */
export class SpatialNameAtlas {
  readonly canvas = document.createElement("canvas");
  readonly texture: CanvasTexture;
  private context: CanvasRenderingContext2D;
  private glyphs = new Map<string, { tile: number[]; advance: number }>();
  private cell = 32;
  private palette: SpatialPalette;
  constructor(palette: SpatialPalette) {
    this.palette = palette;
    this.canvas.width = this.canvas.height = 1024;
    this.context = this.canvas.getContext("2d")!;
    this.texture = new CanvasTexture(this.canvas);
    this.texture.colorSpace = SRGBColorSpace;
    this.texture.generateMipmaps = false;
    this.texture.minFilter = this.texture.magFilter = LinearFilter;
  }
  update(people: readonly Person[]) {
    const characters = new Set<string>(["…"]);
    for (const p of people)
      for (const char of this.lines(p).join("")) characters.add(char);
    // Unusually diverse scripts get smaller glyph cells, never missing people.
    this.cell = characters.size <= 1024 ? 32 : characters.size <= 4096 ? 16 : 8;
    const columns = 1024 / this.cell,
      c = this.context;
    c.clearRect(0, 0, 1024, 1024);
    this.glyphs.clear();
    c.font = "500 26px sans-serif";
    c.textBaseline = "alphabetic";
    c.lineJoin = "round";
    for (const char of characters) {
      if (this.glyphs.size >= columns ** 2) break;
      const slot = this.glyphs.size,
        x = (slot % columns) * this.cell,
        y = Math.floor(slot / columns) * this.cell;
      const advance = c.measureText(char).width;
      c.save();
      c.translate(x, y);
      c.scale(this.cell / 32, this.cell / 32);
      c.lineWidth = 3;
      c.strokeStyle = this.palette.paper;
      c.fillStyle = this.palette.ink;
      // Source glyphs have padding on all sides, including italic overhangs.
      c.strokeText(char, 3, 25, 26);
      c.fillText(char, 3, 25, 26);
      c.restore();
      this.glyphs.set(char, {
        tile: [
          x / 1024,
          1 - (y + this.cell) / 1024,
          this.cell / 1024,
          this.cell / 1024,
        ],
        advance: Math.min(26, advance),
      });
    }
    this.texture.needsUpdate = true;
  }
  private lines(p: Person) {
    return [
      p.surname || p.name,
      p.surname ? p.name : "",
      p.patronymic || "",
      years(p),
    ];
  }
  layout(person: Person): SpatialGlyph[] {
    const result: SpatialGlyph[] = [];
    this.lines(person).forEach((line, row) => {
      const glyphs = [...line].map(
        (char) => this.glyphs.get(char) || this.glyphs.get("…")!,
      );
      let width = glyphs.reduce((sum, glyph) => sum + glyph.advance, 0);
      const scale = Math.min(1, 230 / Math.max(1, width));
      width *= scale;
      let x = -width / 2;
      for (const glyph of glyphs) {
        result.push({
          tile: glyph.tile,
          layout: [
            (x + 13 * scale) / 256,
            (-27 - row * 30) / 256,
            (32 * scale) / 256,
            32 / 256,
          ],
          date: row === 3 ? 1 : 0,
        });
        x += glyph.advance * scale;
      }
    });
    return result;
  }
  dispose() {
    this.glyphs.clear();
    this.texture.dispose();
    this.canvas.width = this.canvas.height = 1;
  }
}
