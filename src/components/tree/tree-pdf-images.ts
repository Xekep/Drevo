import type { jsPDF } from "jspdf";

export type PdfPortraitPlacement = {
  data: string;
  x: number;
  y: number;
  width: number;
  height: number;
};

/** Give cancellation, timers and paint a real task boundary, not only a microtask. */
export async function yieldPdfExport(signal?: AbortSignal) {
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
  signal?.throwIfAborted();
}

function pngBytes(data: string) {
  const prefix = "data:image/png;base64,";
  if (!data.startsWith(prefix)) throw new Error("Некорректный портрет для PDF.");
  const binary = atob(data.slice(prefix.length));
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index++) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

/** Embed existing PNG pixels losslessly, with a reusable alias and FAST filters.
 * svg2pdf otherwise decodes each data URL and lets jsPDF default to SLOW PNG
 * compression. Byte arrays survive only until the source's last placement.
 */
export async function drawPdfPortraits(
  pdf: Pick<jsPDF, "addImage">,
  placements: readonly PdfPortraitPlacement[],
  scale: number,
  signal?: AbortSignal,
  onProgress?: () => void,
) {
  const remaining = new Map<string, number>();
  for (const placement of placements)
    remaining.set(placement.data, (remaining.get(placement.data) || 0) + 1);
  const images = new Map<string, { alias: string; bytes: Uint8Array }>();
  let nextAlias = 0;
  let sliceStarted = performance.now();
  for (const placement of placements) {
    signal?.throwIfAborted();
    const image = images.get(placement.data) || {
      alias: `drevo-portrait-${nextAlias++}`,
      bytes: pngBytes(placement.data),
    };
    pdf.addImage(image.bytes, "PNG", placement.x * scale, placement.y * scale,
      placement.width * scale, placement.height * scale, image.alias, "FAST");
    onProgress?.();
    const usesLeft = remaining.get(placement.data)! - 1;
    if (usesLeft) {
      remaining.set(placement.data, usesLeft);
      images.set(placement.data, image);
    } else {
      remaining.delete(placement.data);
      images.delete(placement.data);
    }
    if (performance.now() - sliceStarted >= 12) {
      await yieldPdfExport(signal);
      sliceStarted = performance.now();
    }
  }
  await yieldPdfExport(signal);
}
