import { drawPortraitCameo } from "../portrait-cameo.ts";

export const placeholderWidth = 1024;
export const placeholderHeight = 512;
const tileSize = 256;

/** Six shared tiles, independent of the number of people or missing photos. */
export function gpuPlaceholderCanvas() {
  const canvas = document.createElement("canvas");
  canvas.width = placeholderWidth;
  canvas.height = placeholderHeight;
  const context = canvas.getContext("2d")!;
  for (const [column, sex] of (["m", "f", "u"] as const).entries()) {
    for (let row = 0; row < 2; row++) {
      context.save();
      context.translate(column * tileSize + 1, row * tileSize + 1);
      context.scale((tileSize - 2) / 80, (tileSize - 2) / 80);
      drawPortraitCameo(context, sex, row === 1);
      context.restore();
    }
  }
  return canvas;
}

export function gpuPlaceholderUv(sex: "f" | "m" | "u", compact: boolean) {
  return [(sex === "m" ? 1 : sex === "f" ? 257 : 513) / placeholderWidth,
    (compact ? 257 : 1) / placeholderHeight,
    254 / placeholderWidth, 254 / placeholderHeight];
}
