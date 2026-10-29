import type { PhotoTag } from "./types.ts";

export type PortraitRegion = Pick<PhotoTag, "x" | "y" | "width" | "height">;
const clamp = (value: number, min: number, max: number) =>
  Math.max(min, Math.min(max, value));

/** Fit the marked rectangle inside the circular preview, not just its square. */
export function portraitInitialFraming(
  width: number,
  height: number,
  region?: PortraitRegion,
) {
  const fallback = { zoom: 1, maxZoom: 6, center: { x: 0.5, y: 0.5 } };
  if (
    !region ||
    ![region.x, region.y, region.width, region.height].every(Number.isFinite) ||
    region.width <= 0 ||
    region.height <= 0
  )
    return fallback;
  const x = clamp(region.x, 0, 1),
    y = clamp(region.y, 0, 1);
  const w = Math.min(region.width, 1 - x),
    h = Math.min(region.height, 1 - y);
  if (w <= 0 || h <= 0) return fallback;
  const diameter = Math.max(1, Math.hypot(w * width, h * height));
  const zoom = Math.max(1, Math.min(width, height) / diameter);
  return {
    zoom,
    maxZoom: Math.max(6, zoom * 3),
    center: { x: x + w / 2, y: y + h / 2 },
  };
}

/** Convert viewport movement into original-image coordinates after rotation. */
export function portraitImageDelta(x: number, y: number, rotation: number) {
  const angle = (rotation * Math.PI) / 180,
    cos = Math.cos(angle),
    sin = Math.sin(angle);
  return { x: x * cos + y * sin, y: -x * sin + y * cos };
}

/** Square crop; its rotated corners remain inside the original image. */
export function portraitCrop(
  width: number,
  height: number,
  zoom: number,
  cx: number,
  cy: number,
  rotation = 0,
  maxZoom = 6,
) {
  const angle = ((Number.isFinite(rotation) ? rotation : 0) * Math.PI) / 180;
  const extent = Math.abs(Math.cos(angle)) + Math.abs(Math.sin(angle));
  const size =
    Math.min(width, height) /
    Math.max(extent, clamp(Number.isFinite(zoom) ? zoom : 1, 1, maxZoom));
  const inset = (size * (extent - 1)) / 2;
  return {
    x: clamp(
      (Number.isFinite(cx) ? cx : 0.5) * width - size / 2,
      inset,
      width - size - inset,
    ),
    y: clamp(
      (Number.isFinite(cy) ? cy : 0.5) * height - size / 2,
      inset,
      height - size - inset,
    ),
    width: size,
    height: size,
  };
}
