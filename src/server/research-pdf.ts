import PDFDocument from "pdfkit";
import { fileURLToPath } from "node:url";
import {
  drawResearchChart,
  drawResearchGraph,
  parseResearchMermaid,
  type ResearchGraph,
} from "./research-pdf-visuals.ts";

export type { ResearchGraph } from "./research-pdf-visuals.ts";

const font = fileURLToPath(
  new URL("../../assets/DejaVuSans.ttf", import.meta.url),
);

function plainText(line: string) {
  return line
    .replace(/\[\[(?:person|choose-person|photo):[^|\]]+\|([^\]]+)\]\]/g, "$1")
    .replace(/\[([^\]]+)\]\((?:https?:\/\/[^)]+|#[^)]+)\)/g, "$1")
    .replace(/\*\*|__|`/g, "")
    .trim();
}

function drawTable(doc: PDFKit.PDFDocument, lines: string[]) {
  const rows = lines
    .filter((line) => !/^\s*\|?[\s:|-]+\|[\s:|-]*\s*$/.test(line))
    .map((line) =>
      line
        .replace(/^\s*\||\|\s*$/g, "")
        .split("|")
        .map(plainText),
    );
  const columns = Math.max(...rows.map((row) => row.length));
  if (!columns || columns > 8) {
    for (const line of lines) doc.fontSize(9).text(plainText(line));
    return;
  }
  const left = 48,
    width = doc.page.width - 96,
    columnWidth = width / columns;
  rows.forEach((row, index) => {
    doc.font("Drevo").fontSize(8.5);
    const height = Math.max(
      27,
      ...row.map(
        (cell) => doc.heightOfString(cell, { width: columnWidth - 14 }) + 12,
      ),
    );
    if (doc.y + height > doc.page.height - 48)
      doc.addPage({ size: "A4", margin: 48 });
    const y = doc.y;
    if (index === 0) doc.rect(left, y, width, height).fill("#edf3ec");
    row.forEach((cell, column) => {
      const x = left + column * columnWidth;
      doc.rect(x, y, columnWidth, height).stroke("#d7e1d7");
      doc.fillColor("#35483b").text(cell, x + 7, y + 6, {
        width: columnWidth - 14,
        height: height - 10,
        ellipsis: true,
      });
    });
    doc.y = y + height;
  });
  doc.moveDown(0.6);
}

function drawMarkdown(doc: PDFKit.PDFDocument, content: string) {
  const lines = content.split(/\r?\n/);
  for (let index = 0; index < lines.length; index++) {
    if (
      /^\s*\|.+\|\s*$/.test(lines[index]) &&
      /^\s*\|?\s*:?-{3,}/.test(lines[index + 1] || "")
    ) {
      const table: string[] = [];
      while (index < lines.length && /^\s*\|.+\|\s*$/.test(lines[index]))
        table.push(lines[index++]);
      drawTable(doc, table);
      index--;
      continue;
    }
    const value = plainText(lines[index]);
    if (!value) {
      doc.moveDown(0.35);
      continue;
    }
    const heading = /^#{1,4}\s+/.test(value);
    doc
      .font("Drevo")
      .fillColor(heading ? "#283e2d" : "#354232")
      .fontSize(heading ? 13 : 10)
      .text(value.replace(/^#{1,4}\s+/, "").replace(/^[-*]\s+/, "• "), {
        lineGap: 3,
        paragraphGap: heading ? 8 : 4,
      });
  }
}

export async function researchPdf(
  title: string,
  content: string,
  graph?: ResearchGraph,
): Promise<Buffer> {
  if (
    !title.trim() ||
    title.length > 160 ||
    !content.trim() ||
    content.length > 30_000
  )
    throw new RangeError(
      "Некорректный заголовок или объём документа (до 30 000 символов)",
    );

  const parts = content.split(/```mermaid[^\r\n]*\r?\n([\s\S]*?)```/gi),
    visuals = parts.map((part, index) =>
      index % 2 ? parseResearchMermaid(part) : undefined,
    );
  const document = new PDFDocument({
    size: "A4",
    margin: 48,
    info: { Title: title },
  });
  document.registerFont("Drevo", font);
  const chunks: Buffer[] = [];
  const completed = new Promise<Buffer>((resolve, reject) => {
    document.on("data", (chunk: Buffer) => chunks.push(chunk));
    document.on("end", () => resolve(Buffer.concat(chunks)));
    document.on("error", reject);
  });
  document
    .font("Drevo")
    .fontSize(18)
    .fillColor("#263e31")
    .text(title.trim(), { lineGap: 4 });
  document.moveDown(0.7);

  let drawnVerified = false;
  for (const [index, part] of parts.entries()) {
    const visual = visuals[index];
    if (!visual) {
      drawMarkdown(document, part);
      continue;
    }
    if (visual.kind === "graph") {
      // Avoid printing the same family graph twice if the model put its
      // Mermaid version in the proposed report as well as the verified data.
      const verifiedNames = new Set(graph?.nodes.map((node) => node.name));
      if (
        graph &&
        graph.nodes.length === visual.graph.nodes.length &&
        visual.graph.nodes.every((node) => verifiedNames.has(node.name))
      ) {
        if (!drawnVerified) await drawResearchGraph(document, graph);
        drawnVerified = true;
      } else
        await drawResearchGraph(document, visual.graph, "Схема исследования");
    } else drawResearchChart(document, visual);
    // Charts may be followed by prose; do not append an empty final page.
    if (parts[index + 1]?.trim()) document.addPage({ size: "A4", margin: 48 });
  }
  if (graph && !drawnVerified) await drawResearchGraph(document, graph);
  document.end();
  return completed;
}
