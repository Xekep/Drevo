import {
  DataTexture,
  FloatType,
  NearestFilter,
  RGBAFormat,
  Vector2,
} from "three";
import type { CardPlacement } from "../../domain/spatial-card-layout.ts";

export const spatialLayoutDeclarations = `
uniform sampler2D cardLayout; uniform vec2 cardLayoutSize;
vec3 readCardLayout(float index) {
  vec2 cell=vec2(mod(index,cardLayoutSize.x),floor(index/cardLayoutSize.x));
  return texture2D(cardLayout,(cell+.5)/cardLayoutSize).xyz;
}`;

/** One tiny camera-dependent texture serves portraits, glyphs and edge clipping.
 * Glyph buffers stay immutable; world positions are not changed by this upload.
 */
export class SpatialCardProjection {
  readonly indices: Map<string, number>;
  readonly dimensions: Vector2;
  readonly data: Float32Array;
  readonly texture: DataTexture;
  constructor(ids: readonly string[]) {
    this.indices = new Map(ids.map((id, index) => [id, index]));
    this.dimensions = new Vector2(
      256,
      Math.max(1, Math.ceil(ids.length / 256)),
    );
    this.data = new Float32Array(this.dimensions.x * this.dimensions.y * 4);
    this.texture = new DataTexture(
      this.data,
      this.dimensions.x,
      this.dimensions.y,
      RGBAFormat,
      FloatType,
    );
    this.texture.minFilter = this.texture.magFilter = NearestFilter;
    this.texture.generateMipmaps = false;
  }
  update(cards: readonly CardPlacement[]) {
    this.data.fill(0);
    for (const card of cards) {
      const index = this.indices.get(card.id);
      if (index === undefined) continue;
      const offset = index * 4;
      this.data[offset] = card.x - card.anchorX;
      this.data[offset + 1] = card.y - card.anchorY;
      this.data[offset + 2] = card.size;
    }
    this.texture.needsUpdate = true;
  }
  dispose() {
    this.texture.dispose();
  }
}
