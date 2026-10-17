import { CanvasTexture, NearestFilter } from "three";

/** One screen-space sample replaces an unbounded per-fragment label loop.
 * Mask pixels never exceed 1 MiB, regardless of device pixel ratio or archive. */
export class SpatialLabelMask {
  readonly canvas = document.createElement("canvas");
  readonly texture: CanvasTexture;
  private context: CanvasRenderingContext2D;
  constructor() {
    this.canvas.width = this.canvas.height = 512;
    this.context = this.canvas.getContext("2d")!;
    this.texture = new CanvasTexture(this.canvas);
    this.texture.generateMipmaps = false;
    this.texture.minFilter = this.texture.magFilter = NearestFilter;
  }
  update(
    people: readonly { x: number; y: number; size: number }[],
    width: number,
    height: number,
  ) {
    const c = this.context;
    c.clearRect(0, 0, 512, 512);
    c.save();
    c.scale(512 / width, 512 / height);
    c.fillStyle = "#fff";
    for (const p of people) {
      c.beginPath();
      c.arc(p.x, p.y - p.size * 0.24, p.size * 0.205 + 1, 0, Math.PI * 2);
      c.fill();
      // Text rows, leaving the spaces around portrait and name transparent.
      c.fillRect(
        p.x - p.size * 0.46,
        p.y + p.size * 0.055,
        p.size * 0.92,
        p.size * 0.35,
      );
      if (p.size > 110)
        c.fillRect(
          p.x - p.size * 0.4,
          p.y + p.size * 0.405,
          p.size * 0.8,
          p.size * 0.12,
        );
    }
    c.restore();
    this.texture.needsUpdate = true;
  }
  dispose() {
    this.texture.dispose();
    this.canvas.width = this.canvas.height = 1;
  }
}
