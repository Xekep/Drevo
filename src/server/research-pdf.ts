import PDFDocument from "pdfkit";
import { fileURLToPath } from "node:url";
import ELK from "elkjs/lib/elk.bundled.js";
import type { ElkNode } from "elkjs";

export type ResearchGraph = {
  nodes: Array<{ id: string; name: string; birth?: string; death?: string }>;
  edges: Array<{ from: string; to: string; type: string }>;
};

const font = fileURLToPath(
  new URL("../../assets/DejaVuSans.ttf", import.meta.url),
);

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

  // The diagram uses verified archive relations, not model prose or Mermaid code.
  let layout: ElkNode | undefined;
  if (graph) {
    if (
      !graph.nodes.length ||
      graph.nodes.length > 180 ||
      graph.edges.length > 500
    )
      throw new RangeError("Схема слишком велика для одного PDF");
    const ids = new Set(graph.nodes.map((node) => node.id));
    layout = await new ELK().layout({
      id: "family",
      layoutOptions: {
        "elk.algorithm": "layered",
        "elk.direction": "DOWN",
        "elk.layered.crossingMinimization.strategy": "LAYER_SWEEP",
        "elk.spacing.nodeNode": "28",
        "elk.layered.spacing.nodeNodeBetweenLayers": "54",
      },
      children: graph.nodes.map((node) => ({
        id: node.id,
        width: 172,
        height: 54,
      })),
      edges: graph.edges
        .filter((edge) => ids.has(edge.from) && ids.has(edge.to))
        .map((edge, index) => ({
          id: `edge-${index}`,
          sources: [edge.from],
          targets: [edge.to],
        })),
    });
  }

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
  document.font("Drevo").fontSize(18).text(title.trim(), { lineGap: 4 });
  document.moveDown(0.8);
  for (const line of content.split(/\r?\n/)) {
    const value = line
      .replace(/\[\[(?:person|photo):[^|\]]+\|([^\]]+)\]\]/g, "$1")
      .replace(/\[([^\]]+)\]\((?:https?:\/\/[^)]+|#[^)]+)\)/g, "$1")
      .replace(/\*\*|__|`/g, "")
      .trim();
    if (!value) {
      document.moveDown(0.5);
      continue;
    }
    const heading = /^#{1,4}\s+/.test(value);
    document
      .fontSize(heading ? 13 : 10.5)
      .text(value.replace(/^#{1,4}\s+/, "").replace(/^[-*]\s+/, "• "), {
        lineGap: 4,
        paragraphGap: heading ? 7 : 3,
      });
  }
  if (layout && graph) {
    const margin = 42,
      graphWidth = layout.width || 0,
      graphHeight = layout.height || 0,
      scale = Math.min(
        1,
        10000 / (graphWidth + 84),
        10000 / (graphHeight + 126),
      ),
      width = Math.max(842, graphWidth * scale + margin * 2),
      height = Math.max(595, graphHeight * scale + margin * 2 + 42);
    document.addPage({ size: [width, height], margin: 0 });
    document
      .font("Drevo")
      .fillColor("#283e2d")
      .fontSize(16)
      .text("Схема родственных связей", margin, 24);
    document
      .save()
      .translate((width - graphWidth * scale) / 2, margin + 42)
      .scale(scale);
    const ids = new Set(graph.nodes.map((node) => node.id));
    const kind = new Map(
      graph.edges
        .filter((edge) => ids.has(edge.from) && ids.has(edge.to))
        .map((edge, index) => [`edge-${index}`, edge.type]),
    );
    for (const edge of layout.edges || []) {
      const color = kind.get(edge.id) === "parent" ? "#5b7657" : "#b07e57";
      for (const section of edge.sections || []) {
        const points = [
          section.startPoint,
          ...(section.bendPoints || []),
          section.endPoint,
        ];
        document.save().strokeColor(color).lineWidth(1.4);
        if (kind.get(edge.id) !== "parent") document.dash(5, { space: 3 });
        points.forEach((point, index) =>
          index
            ? document.lineTo(point.x, point.y)
            : document.moveTo(point.x, point.y),
        );
        document.stroke().restore();
      }
    }
    const byId = new Map(graph.nodes.map((node) => [node.id, node]));
    for (const node of layout.children || []) {
      const person = byId.get(node.id);
      if (!person) continue;
      const x = node.x || 0,
        y = node.y || 0;
      document
        .roundedRect(x, y, 172, 54, 7)
        .fillAndStroke("#f0f5eb", "#a5b99a");
      document
        .fillColor("#273d2d")
        .font("Drevo")
        .fontSize(9)
        .text(person.name, x + 8, y + 7, {
          width: 156,
          height: 35,
          ellipsis: true,
        });
      const dates = [person.birth?.slice(0, 4), person.death?.slice(0, 4)]
        .filter(Boolean)
        .join(" — ");
      if (dates)
        document
          .fontSize(7)
          .fillColor("#61725b")
          .text(dates, x + 8, y + 42, { width: 156 });
    }
    document.restore();
    document
      .fontSize(8)
      .fillColor("#61725b")
      .text(
        "Сплошные линии — родитель и ребёнок; пунктир — брак или иная связь.",
        margin,
        height - 18,
      );
  }
  document.end();
  return completed;
}
