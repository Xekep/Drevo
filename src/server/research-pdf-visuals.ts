import ELK from "elkjs/lib/elk.bundled.js";
import type { ElkNode } from "elkjs";

export type ResearchGraph = {
  nodes: Array<{ id: string; name: string; birth?: string; death?: string }>;
  edges: Array<{ from: string; to: string; type: string }>;
};

export type ResearchVisual =
  | { kind: "graph"; graph: ResearchGraph }
  | {
      kind: "pie";
      title: string;
      values: Array<{ label: string; value: number }>;
    }
  | {
      kind: "chart";
      title: string;
      labels: string[];
      values: number[];
      series: "bar" | "line";
    };

const A4 = { width: 841.89, height: 595.28 },
  A3 = { width: 1190.55, height: 841.89 },
  margin = 38,
  palette = [
    "#486d57",
    "#719b77",
    "#a8bb82",
    "#bf9c68",
    "#7899a6",
    "#977f9b",
    "#ac7669",
  ];

function validNumber(value: string) {
  const number = Number(value.replace(",", "."));
  return Number.isFinite(number) && number >= 0 ? number : undefined;
}

/** Convert the diagram formats the research assistant can request into verified vector primitives. */
export function parseResearchMermaid(source: string): ResearchVisual {
  const lines = source
    .trim()
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  if (/^pie\b/i.test(lines[0])) {
    let title =
      lines[0].match(/\btitle\s+(.+)$/i)?.[1]?.trim() || "Распределение";
    const values: Array<{ label: string; value: number }> = [];
    for (const line of lines.slice(1)) {
      if (/^title\s+/i.test(line))
        title = line.replace(/^title\s+/i, "").trim();
      const match = /^"([^"]+)"\s*:\s*(\d+(?:[.,]\d+)?)$/.exec(line);
      if (match) {
        const value = validNumber(match[2]);
        if (value !== undefined) values.push({ label: match[1], value });
      }
    }
    if (
      !values.length ||
      values.length > 30 ||
      !values.some((item) => item.value > 0)
    )
      throw new RangeError(
        "Для круговой диаграммы нужны от 1 до 30 числовых значений",
      );
    return { kind: "pie", title, values };
  }
  if (/^xychart(?:-beta)?\b/i.test(lines[0])) {
    const title =
      lines
        .find((line) => /^title\s+/i.test(line))
        ?.replace(/^title\s+/i, "")
        .replace(/^"|"$/g, "") || "Данные архива";
    const axis = lines.find((line) => /^x-axis\s+/i.test(line));
    const series = lines.find((line) => /^(?:bar|line)\s*\[/i.test(line));
    const raw = series?.match(/^(bar|line)\s*\[([^\]]+)\]/i);
    if (!raw)
      throw new RangeError(
        "График должен содержать bar или line с числовыми значениями",
      );
    const values = raw[2].split(",").map((item) => validNumber(item.trim()));
    if (
      !values.length ||
      values.length > 100 ||
      values.some((item) => item === undefined)
    )
      throw new RangeError("Для графика нужны от 1 до 100 числовых значений");
    const labelContent = axis?.match(/\[([^\]]+)\]/)?.[1] || "";
    const labels = [
      ...labelContent.matchAll(/"([^"]+)"|'([^']+)'|([^,\s]+)/g),
    ].map((match) => match[1] || match[2] || match[3]);
    return {
      kind: "chart",
      title,
      series: raw[1].toLowerCase() as "bar" | "line",
      labels: values.map((_, index) => labels[index] || String(index + 1)),
      values: values as number[],
    };
  }
  if (/^(?:graph|flowchart)\s+(?:TD|TB|LR|RL|BT)\b/i.test(lines[0])) {
    const nodes = new Map<string, string>();
    const edges: ResearchGraph["edges"] = [];
    for (const line of lines.slice(1)) {
      const reduced = line.replace(
        /([a-z][\w-]*)\s*(?:\["([^"]+)"\]|\[([^\]]+)\]|\("([^"]+)"\))/giu,
        (
          _whole,
          id: string,
          quoted?: string,
          square?: string,
          round?: string,
        ) => {
          nodes.set(
            id,
            (quoted || square || round || id).replace(/<[^>]+>/g, " ").trim(),
          );
          return id;
        },
      );
      const edge =
        /^([a-z][\w-]*)\s*(-->(?:\|[^|]+\|)?|---|==>|-\.\s*(?:"[^"]+"\s*)?\.->)\s*([a-z][\w-]*)\s*;?$/iu.exec(
          reduced,
        );
      if (edge) {
        if (!nodes.has(edge[1])) nodes.set(edge[1], edge[1]);
        if (!nodes.has(edge[3])) nodes.set(edge[3], edge[3]);
        edges.push({
          from: edge[1],
          to: edge[3],
          type:
            edge[2] === "---"
              ? "spouse"
              : edge[2].startsWith("-->")
                ? "parent"
                : "other",
        });
      } else if (/-->|---|==>|-\.|\.->/.test(reduced))
        throw new RangeError(
          "Схема содержит связь в неподдерживаемом формате Mermaid",
        );
    }
    if (!nodes.size || nodes.size > 180 || edges.length > 500)
      throw new RangeError("Схема должна содержать от 1 до 180 узлов");
    return {
      kind: "graph",
      graph: { nodes: [...nodes].map(([id, name]) => ({ id, name })), edges },
    };
  }
  throw new RangeError(
    "В PDF поддерживаются Mermaid graph/flowchart, pie и xychart",
  );
}

function visualPage(
  doc: PDFKit.PDFDocument,
  title: string,
  format: "A4" | "A3" = "A4",
) {
  const bounds = format === "A4" ? A4 : A3;
  doc.addPage({ size: format, layout: "landscape", margin: 0 });
  doc
    .font("Drevo")
    .fontSize(14)
    .fillColor("#263e31")
    .text(title, margin, 24, {
      width: bounds.width - margin * 2,
      height: 28,
      ellipsis: true,
    });
  return bounds;
}

function graphDrawing(
  doc: PDFKit.PDFDocument,
  graph: ResearchGraph,
  layout: ElkNode,
  bounds: { width: number; height: number },
  viewport: {
    x: number;
    y: number;
    width: number;
    height: number;
    scale: number;
    detail?: boolean;
  },
) {
  const area = {
    x: margin,
    y: 68,
    width: bounds.width - margin * 2,
    height: bounds.height - 116,
  };
  doc.save().rect(area.x, area.y, area.width, area.height).clip();
  doc
    .translate(
      area.x +
        (area.width - viewport.width * viewport.scale) / 2 -
        viewport.x * viewport.scale,
      area.y +
        (area.height - viewport.height * viewport.scale) / 2 -
        viewport.y * viewport.scale,
    )
    .scale(viewport.scale);
  const types = new Map(
    graph.edges.map((edge, index) => [`edge-${index}`, edge.type]),
  );
  for (const edge of layout.edges || []) {
    const type = types.get(edge.id);
    for (const section of edge.sections || []) {
      doc
        .save()
        .strokeColor(type === "parent" ? "#708a74" : "#aa8d6b")
        .lineWidth(1.4);
      if (type !== "parent") doc.dash(4, { space: 3 });
      [
        section.startPoint,
        ...(section.bendPoints || []),
        section.endPoint,
      ].forEach((point, index) =>
        index ? doc.lineTo(point.x, point.y) : doc.moveTo(point.x, point.y),
      );
      doc.stroke().restore();
    }
  }
  const byId = new Map(graph.nodes.map((node) => [node.id, node]));
  for (const node of layout.children || []) {
    const person = byId.get(node.id);
    if (!person) continue;
    const x = node.x || 0,
      y = node.y || 0;
    // Detail sheets overlap. Draw a card only on pages where the whole card
    // fits; every card is still present in the overview and on a detail sheet.
    if (
      viewport.detail &&
      (x < viewport.x ||
        y < viewport.y ||
        x + 172 > viewport.x + viewport.width ||
        y + 54 > viewport.y + viewport.height)
    )
      continue;
    doc.roundedRect(x, y, 172, 54, 3).fillAndStroke("#ffffff", "#a9b9aa");
    doc
      .fillColor("#263a30")
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
      doc
        .fontSize(7)
        .fillColor("#637168")
        .text(dates, x + 8, y + 42, { width: 156 });
  }
  doc.restore();
}

export async function drawResearchGraph(
  doc: PDFKit.PDFDocument,
  graph: ResearchGraph,
  title = "Схема родственных связей",
) {
  if (
    !graph.nodes.length ||
    graph.nodes.length > 180 ||
    graph.edges.length > 500
  )
    throw new RangeError(
      "Схема слишком велика для PDF (до 180 людей и 500 связей)",
    );
  const ids = new Set(graph.nodes.map((node) => node.id));
  const edges = graph.edges.filter(
    (edge) => ids.has(edge.from) && ids.has(edge.to),
  );
  const layout = await new ELK().layout<ElkNode>({
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
    edges: edges.map((edge, index) => ({
      id: `edge-${index}`,
      sources: [edge.from],
      targets: [edge.to],
    })),
  });
  const width = Math.max(1, layout.width || 0),
    height = Math.max(1, layout.height || 0);
  const areaWidth = A4.width - margin * 2,
    areaHeight = A4.height - 116;
  const overviewScale = Math.min(1, areaWidth / width, areaHeight / height);
  const overview = visualPage(doc, title);
  graphDrawing(doc, { ...graph, edges }, layout, overview, {
    x: 0,
    y: 0,
    width,
    height,
    scale: overviewScale,
  });
  doc
    .font("Drevo")
    .fontSize(8)
    .fillColor("#69796f")
    .text(
      "Сплошные линии — родители и дети; пунктир — брак или другая связь.",
      margin,
      A4.height - 29,
    );
  if (overviewScale >= 0.64) return;

  // An A4 overview contains every node. A3 detail sheets let readers inspect
  // large archives without a non-standard, giant PDF page or tiny labels.
  const detailWidth = A3.width - margin * 2,
    detailHeight = A3.height - 116;
  let detailScale = 0.85;
  while (
    Math.ceil(width / (detailWidth / detailScale - 192)) *
      Math.ceil(height / (detailHeight / detailScale - 74)) >
    40
  )
    detailScale *= 0.85;
  const tileWidth = detailWidth / detailScale,
    tileHeight = detailHeight / detailScale;
  const strideX = tileWidth - 192,
    strideY = tileHeight - 74;
  const cols = Math.max(1, Math.ceil((width - tileWidth) / strideX) + 1),
    rows = Math.max(1, Math.ceil((height - tileHeight) / strideY) + 1);
  for (let row = 0; row < rows; row++)
    for (let col = 0; col < cols; col++) {
      const index = row * cols + col + 1,
        bounds = visualPage(
          doc,
          `${title} · фрагмент ${index} из ${cols * rows}`,
          "A3",
        );
      graphDrawing(doc, { ...graph, edges }, layout, bounds, {
        x: col * strideX,
        y: row * strideY,
        width: tileWidth,
        height: tileHeight,
        scale: detailScale,
        detail: true,
      });
      doc
        .font("Drevo")
        .fontSize(8)
        .fillColor("#69796f")
        .text(
          `Участок ${col + 1}/${cols} по горизонтали, ${row + 1}/${rows} по вертикали. Общая схема — на предыдущей странице.`,
          margin,
          A3.height - 28,
        );
    }
}

export function drawResearchChart(
  doc: PDFKit.PDFDocument,
  visual: Exclude<ResearchVisual, { kind: "graph" }>,
) {
  if (visual.kind === "pie") {
    const total = visual.values.reduce((sum, item) => sum + item.value, 0);
    let bounds = visualPage(doc, visual.title);
    const cx = 260,
      cy = 305,
      radius = 150;
    let angle = -Math.PI / 2;
    visual.values.forEach((item, index) => {
      if (item.value <= 0) return;
      const delta = (item.value / total) * Math.PI * 2,
        end = angle + delta,
        startX = cx + radius * Math.cos(angle),
        startY = cy + radius * Math.sin(angle),
        endX = cx + radius * Math.cos(end),
        endY = cy + radius * Math.sin(end);
      if (delta > Math.PI * 2 - 0.0001)
        doc.circle(cx, cy, radius).fill(palette[index % palette.length]);
      else
        doc
          .path(
            `M ${cx} ${cy} L ${startX} ${startY} A ${radius} ${radius} 0 ${delta > Math.PI ? 1 : 0} 1 ${endX} ${endY} Z`,
          )
          .fill(palette[index % palette.length]);
      angle = end;
    });
    let x = 470,
      y = 100;
    visual.values.forEach((item, index) => {
      const label = `${item.label} — ${item.value}`;
      doc.font("Drevo").fontSize(9);
      const rowHeight = Math.max(
        30,
        doc.heightOfString(label, { width: bounds.width - x - margin - 20 }) +
          7,
      );
      if (y + rowHeight > bounds.height - 52) {
        bounds = visualPage(doc, visual.title + " · продолжение");
        x = 94;
        y = 100;
      }
      doc.rect(x, y + 5, 11, 11).fill(palette[index % palette.length]);
      doc.fillColor("#34483a").text(label, x + 20, y, {
        width: bounds.width - x - margin - 20,
      });
      y += rowHeight;
    });
    return;
  }
  const { labels, values } = visual;
  const maximum = Math.max(1, ...values);
  for (let offset = 0; offset < values.length; offset += 13) {
    visualPage(doc, visual.title + (offset ? " · продолжение" : ""));
    const slice = values.slice(offset, offset + 13);
    if (visual.series === "line") {
      const left = 96,
        right = 752,
        top = 96,
        bottom = 464;
      for (let tick = 0; tick <= 4; tick++) {
        const y = bottom - (tick * (bottom - top)) / 4;
        doc.moveTo(left, y).lineTo(right, y).lineWidth(0.5).stroke("#dce5da");
        doc
          .font("Drevo")
          .fontSize(8)
          .fillColor("#637168")
          .text(
            String(Math.round(((maximum * tick) / 4) * 10) / 10),
            48,
            y - 5,
            { width: 40, align: "right" },
          );
      }
      let previous: { x: number; y: number } | undefined;
      slice.forEach((value, index) => {
        const x =
            left +
            (slice.length === 1
              ? (right - left) / 2
              : (index / (slice.length - 1)) * (right - left)),
          y = bottom - (value / maximum) * (bottom - top);
        if (previous)
          doc
            .moveTo(previous.x, previous.y)
            .lineTo(x, y)
            .lineWidth(1.6)
            .stroke("#486d57");
        doc.circle(x, y, 3).fill("#486d57");
        doc
          .font("Drevo")
          .fontSize(8)
          .fillColor("#35483b")
          .text(labels[offset + index], x - 35, bottom + 10, {
            width: 70,
            height: 32,
            align: "center",
            ellipsis: true,
          });
        previous = { x, y };
      });
      continue;
    }
    slice.forEach((value, index) => {
      const y = 100 + index * 34;
      doc
        .font("Drevo")
        .fontSize(9)
        .fillColor("#35483b")
        .text(labels[offset + index], 44, y, {
          width: 220,
          height: 25,
          ellipsis: true,
        });
      doc.rect(282, y + 1, (value / maximum) * 440, 17).fill("#719b77");
      doc
        .fillColor("#263e31")
        .fontSize(9)
        .text(String(value), 733, y, { width: 68 });
    });
  }
}
