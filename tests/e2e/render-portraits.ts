import sharp from "sharp";

/** Distinct generated photographs; no user media. Same dimensions/quality as previews. */
export async function renderPortraits(ids: readonly string[]) {
  const images = new Map<string, Buffer>();
  for (const [index, id] of ids.entries()) {
    const size = 400,
      pixels = Buffer.alloc(size * size * 3);
    let seed = index + 1;
    for (let y = 0; y < size; y++)
      for (let x = 0; x < size; x++) {
        seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
        const face = Math.hypot((x - 200) / 85, (y - 145) / 110) < 1;
        const body = Math.hypot((x - 200) / 160, (y - 380) / 140) < 1;
        const value =
          (face
            ? 145 + (index % 65)
            : body
              ? 50 + (index % 60)
              : 195 + (index % 30)) +
          (seed >>> 27);
        const offset = (y * size + x) * 3;
        pixels[offset] = value;
        pixels[offset + 1] = value - (index % 18);
        pixels[offset + 2] = value - (index % 28);
      }
    for (const [variant, width, quality] of [
      ["tiny", 48, 45],
      ["thumb", 400, 76],
    ] as const) {
      images.set(
        `${id}-${variant}`,
        await sharp(pixels, { raw: { width: size, height: size, channels: 3 } })
          .resize(width, width)
          .jpeg({ quality })
          .toBuffer(),
      );
    }
  }
  return images;
}
