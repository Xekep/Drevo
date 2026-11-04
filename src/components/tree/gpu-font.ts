import TinySDF from "@mapbox/tiny-sdf";

export const gpuFontSize = 64;
export const gpuFontBuffer = 8;
export const gpuFontAtlasSize = 2048;
const family = '"Segoe UI Variable Text", "Segoe UI", -apple-system, BlinkMacSystemFont, Arial, sans-serif';

/** Store distance to the outline instead of repeatedly shrinking antialiased pixels. */
export function createGpuFont() {
  const data = new Uint8Array(gpuFontAtlasSize ** 2);
  const fonts = [400, 600].map(fontWeight => {
    const sdf = new TinySDF({ fontSize: gpuFontSize, buffer: gpuFontBuffer, radius: 8,
      cutoff: 0.25, fontFamily: family, fontWeight: String(fontWeight) });
    const canvas = document.createElement("canvas");
    const context = canvas.getContext("2d")!;
    context.font = `${fontWeight} ${gpuFontSize}px ${family}`;
    const metrics = context.measureText("Mg");
    if (!Number.isFinite(metrics.fontBoundingBoxAscent) || !Number.isFinite(metrics.fontBoundingBoxDescent))
      throw new Error("Native font metrics required");
    return { sdf, ascent: metrics.fontBoundingBoxAscent, descent: metrics.fontBoundingBoxDescent };
  });
  const glyphs = new Map<string, { x: number; y: number; width: number; height: number;
    left: number; top: number; advance: number; ascent: number; descent: number }>();
  let x = 1, y = 1, rowHeight = 0;
  return {
    data,
    get count() { return glyphs.size; },
    glyph(letter: string, bold: boolean) {
      const key = `${bold}:${letter}`, cached = glyphs.get(key);
      if (cached) return cached;
      const font = fonts[bold ? 1 : 0], glyph = font.sdf.draw(letter);
      if (x + glyph.width + 1 > gpuFontAtlasSize) { x = 1; y += rowHeight + 1; rowHeight = 0; }
      if (y + glyph.height + 1 > gpuFontAtlasSize) throw new Error("GPU glyph budget exceeded");
      for (let row = 0; row < glyph.height; row++)
        data.set(glyph.data.subarray(row * glyph.width, (row + 1) * glyph.width), (y + row) * gpuFontAtlasSize + x);
      const result = { x, y, width: glyph.width, height: glyph.height,
        left: glyph.glyphLeft - gpuFontBuffer, top: glyph.glyphTop + gpuFontBuffer,
        advance: glyph.glyphAdvance, ascent: font.ascent, descent: font.descent };
      glyphs.set(key, result);
      x += glyph.width + 1;
      rowHeight = Math.max(rowHeight, glyph.height);
      return result;
    },
  };
}
