import test from "node:test";
import assert from "node:assert/strict";
import { jsPDF } from "jspdf";
import sharp from "sharp";
import { getDocument, OPS } from "pdfjs-dist/legacy/build/pdf.mjs";
import { drawPdfPortraits, type PdfPortraitPlacement } from "../src/components/tree/tree-pdf-images.ts";

async function portrait(color: string) {
  const png = await sharp({ create: { width: 64, height: 64, channels: 4, background: color } })
    .composite([{ input: Buffer.from('<svg width="64" height="64"><circle cx="32" cy="32" r="32" fill="white"/></svg>'), blend: "dest-in" }])
    .png().toBuffer();
  return `data:image/png;base64,${png.toString("base64")}`;
}

test("PDF portrait embedding reuses decoded bytes and aliases at the physical UserUnit scale", async () => {
  const a = await portrait("#be4628"), b = await portrait("#31779a");
  const placements = [a, b, a].map((data, index) => ({ data, x: index * 200, y: 100, width: 126, height: 126 }));
  const calls: unknown[][] = [];
  let progress = 0;
  const pdf = { addImage: (...args: unknown[]) => calls.push(args) } as unknown as Pick<jsPDF, "addImage">;
  await drawPdfPortraits(pdf, placements, 0.075, undefined, () => progress++);
  assert.equal(calls.length, 3);
  assert.equal(progress, calls.length, "only a completed placement advances the export watchdog");
  assert.equal(calls[0][0], calls[2][0], "a repeated portrait shares its decoded PNG byte array");
  assert.equal(calls[0][6], calls[2][6], "a repeated portrait shares its PDF XObject alias");
  assert.notEqual(calls[0][6], calls[1][6]);
  assert.deepEqual(calls[0].slice(1, 6), ["PNG", 0, 7.5, 9.45, 9.45]);
  for (const call of calls) {
    assert.ok(call[0] instanceof Uint8Array);
    assert.equal(call[7], "FAST");
  }
});

test("FAST embedding preserves round alpha pixels and deduplicated image operators", async () => {
  const red = await portrait("#be4628"), blue = await portrait("#31779a");
  const placements: PdfPortraitPlacement[] = [red, blue, red].map((data, index) =>
    ({ data, x: 15 + index * 90, y: 25, width: 64, height: 64 }));
  const fast = new jsPDF({ unit: "pt", orientation: "landscape", format: [320, 160], compress: true });
  const slow = new jsPDF({ unit: "pt", orientation: "landscape", format: [320, 160], compress: true });
  await drawPdfPortraits(fast, placements, 1);
  for (const placement of placements)
    slow.addImage(new Uint8Array(Buffer.from(placement.data.split(",")[1], "base64")), "PNG",
      placement.x, placement.y, placement.width, placement.height, placement.data === red ? "red" : "blue", "SLOW");
  const render = async (doc: jsPDF) => {
    const bytes = doc.output("arraybuffer");
    assert.match(Buffer.from(bytes).toString("latin1"), /\/SMask/);
    const pdf = await getDocument({ data: new Uint8Array(bytes) }).promise;
    try {
      const page = await pdf.getPage(1), viewport = page.getViewport({ scale: 1 });
      assert.ok(viewport.width > viewport.height);
      const operators = await page.getOperatorList();
      const imageIds = operators.fnArray.flatMap((op, index) => op === OPS.paintImageXObject ? [operators.argsArray[index][0]] : []);
      assert.equal(imageIds.length, 3);
      assert.equal(new Set(imageIds).size, 2);
      const factory = pdf.canvasFactory as { create: (width: number, height: number) => {
        canvas: HTMLCanvasElement; context: CanvasRenderingContext2D;
      } };
      const canvas = factory.create(viewport.width, viewport.height);
      await page.render({ canvas: canvas.canvas, canvasContext: canvas.context, viewport }).promise;
      const pixels = new Uint8Array(canvas.context.getImageData(0, 0, viewport.width, viewport.height).data);
      canvas.canvas.width = canvas.canvas.height = 0;
      return { pixels, width: viewport.width };
    } finally { await pdf.loadingTask.destroy(); }
  };
  const reference = await render(slow), result = await render(fast);
  assert.deepEqual(result.pixels, reference.pixels, "FAST PNG compression is lossless, including soft-mask alpha");
  const sample = (x: number, y: number) => [...result.pixels.subarray((y * result.width + x) * 4, (y * result.width + x) * 4 + 4)];
  assert.deepEqual(sample(15, 25), [255, 255, 255, 255]);
  assert.deepEqual(sample(47, 57), [190, 70, 40, 255]);
});

test("a timer cancellation interrupts portrait batches before remaining work", async () => {
  const data = await portrait("#be4628"), controller = new AbortController();
  let calls = 0, progress = 0;
  const pdf = { addImage: () => {
    if (!calls++) setTimeout(() => controller.abort(), 0);
    const until = performance.now() + 7;
    while (performance.now() < until) { /* Simulate a synchronous PNG decoder. */ }
  } } as unknown as Pick<jsPDF, "addImage">;
  const placements = Array.from({ length: 20 }, () => ({ data, x: 0, y: 0, width: 100, height: 100 }));
  await assert.rejects(drawPdfPortraits(pdf, placements, 1, controller.signal, () => progress++), { name: "AbortError" });
  assert.ok(calls < placements.length, "macrotask yields let the abort timer run during an export");
  assert.equal(progress, calls);
  await assert.rejects(drawPdfPortraits(pdf, placements, 1, controller.signal, () => progress++), { name: "AbortError" });
  assert.equal(progress, calls, "an already cancelled task cannot fabricate progress");
});
