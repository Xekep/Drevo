export type ResearchGraph = {
  nodes: Array<{
    id: string;
    name: string;
    label?: string;
    birth?: string;
    death?: string;
  }>;
  edges: Array<{ from: string; to: string; type: string; label?: string }>;
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

function validNumber(value: string) {
  const number = Number(value.replace(",", "."));
  return Number.isFinite(number) && number >= 0 ? number : undefined;
}

function nodeText(value: string) {
  return value
    .replace(/<br\s*\/?\s*>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&(?:amp|lt|gt|quot);/g, (entity) =>
      ({ "&amp;": "&", "&lt;": "<", "&gt;": ">", "&quot;": '"' })[
        entity.toLowerCase() as "&amp;" | "&lt;" | "&gt;" | "&quot;"
      ],
    )
    .trim();
}

/** Parse the restricted Mermaid formats accepted by both chat and PDF. */
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
    const nodes = new Map<string, { name: string; label: string }>();
    const edges: ResearchGraph["edges"] = [];
    for (const line of lines.slice(1)) {
      const reduced = line.replace(
        /([a-z][\w-]*)\s*(?:\["([^"]+)"\]|\[([^\]]+)\]|\("([^"]+)"\))/giu,
        (_whole, id: string, quoted?: string, square?: string, round?: string) => {
          const label = nodeText(quoted || square || round || id);
          nodes.set(id, { name: label.replace(/\s*\n\s*/g, " "), label });
          return id;
        },
      );
      const edge =
        /^([a-z][\w-]*)\s*(-->|---|-\.->|-\.\s*"([^"]+)"\s*\.->|==>)\s*(?:\|([^|]+)\|)?\s*([a-z][\w-]*)\s*;?$/iu.exec(
          reduced,
        );
      if (edge) {
        if (!nodes.has(edge[1]))
          nodes.set(edge[1], { name: edge[1], label: edge[1] });
        if (!nodes.has(edge[5]))
          nodes.set(edge[5], { name: edge[5], label: edge[5] });
        edges.push({
          from: edge[1],
          to: edge[5],
          type:
            edge[2] === "---"
              ? "spouse"
              : edge[2] === "-->"
                ? "parent"
                : "other",
          label: (edge[4] || edge[3])?.trim(),
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
      graph: {
        nodes: [...nodes].map(([id, value]) => ({ id, ...value })),
        edges,
      },
    };
  }
  throw new RangeError(
    "В PDF поддерживаются Mermaid graph/flowchart, pie и xychart",
  );
}
