import { fullName, resolvedSex, safeUrl, years } from "../../domain";
import { roundedRoute } from "../../domain/edge-routing";
import { mediaPreview } from "../../domain/media-preview";
import { edgeLabelPlacement } from "./edge-label-placement";
import { personRelationLabel } from "./person-relation-label";
import type { ExportTree } from "./tree-pdf";

const SVG = "http://www.w3.org/2000/svg";
const PADDING = 150; // Room for labels on relationships outside the node bounds.
const MAX_DISPLAY_SIDE = 16_000;

function element<K extends keyof SVGElementTagNameMap>(
  tag: K,
  attributes: Record<string, string | number | undefined> = {},
): SVGElementTagNameMap[K] {
  const node = document.createElementNS(SVG, tag);
  for (const [key, value] of Object.entries(attributes))
    if (value !== undefined) node.setAttribute(key, String(value));
  return node;
}

function text(
  parent: SVGElement,
  content: string,
  x: number,
  y: number,
  attributes: Record<string, string | number | undefined> = {},
) {
  const node = element("text", { x, y, "font-family": "Arial, sans-serif", ...attributes });
  node.textContent = content;
  parent.append(node);
  return node;
}

function fittedLines(
  value: string,
  width: number,
  size: number,
  limit: number,
  context: CanvasRenderingContext2D,
) {
  context.font = `600 ${size}px Arial`;
  const words = value.trim().split(/\s+/).filter(Boolean);
  const lines: string[] = [];
  let line = "";
  const push = () => {
    if (line) lines.push(line);
    line = "";
  };
  for (const word of words) {
    const next = line ? `${line} ${word}` : word;
    if (context.measureText(next).width <= width) {
      line = next;
      continue;
    }
    push();
    if (context.measureText(word).width <= width) {
      line = word;
      continue;
    }
    for (const character of Array.from(word)) {
      if (context.measureText(line + character).width > width) push();
      line += character;
    }
  }
  push();
  if (lines.length > limit) {
    lines.length = limit;
    while (context.measureText(`${lines[limit - 1]}…`).width > width)
      lines[limit - 1] = lines[limit - 1].slice(0, -1);
    lines[limit - 1] += "…";
  }
  return lines;
}

async function embeddedPhotos(tree: ExportTree, signal?: AbortSignal) {
  const urls = new Map(
    tree.nodes.flatMap((node) => {
      if (node.type !== "person") return [];
      const url = mediaPreview(safeUrl(node.data.person.photo));
      return url ? [[node.data.person.id, url] as const] : [];
    }),
  );
  const entries = [...urls];
  const result = new Map<string, string>();
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(4, entries.length) }, async () => {
      while (next < entries.length) {
        signal?.throwIfAborted();
        const [id, url] = entries[next++];
        try {
          const response = await fetch(url, { credentials: "same-origin", signal });
          if (!response.ok) continue;
          const blob = await response.blob();
          if (!/^image\/(png|jpeg|webp|gif)$/.test(blob.type)) continue;
          const data = await new Promise<string>((resolve, reject) => {
            const reader = new FileReader();
            reader.onload = () => resolve(String(reader.result));
            reader.onerror = () => reject(reader.error);
            reader.readAsDataURL(blob);
          });
          result.set(id, data);
        } catch (error) {
          if (signal?.aborted) throw error;
          // A missing portrait should not prevent exporting the family graph.
        }
      }
    }),
  );
  return result;
}

function avatar(
  parent: SVGElement,
  defs: SVGDefsElement,
  id: string,
  x: number,
  y: number,
  diameter: number,
  photo: string | undefined,
  sex: "m" | "f" | "u",
) {
  const color = sex === "f" ? "#f3ede7" : sex === "m" ? "#eaf0e4" : "#eef2f4";
  const ink = sex === "f" ? "#b3957e" : sex === "m" ? "#81946d" : "#6d8790";
  const radius = diameter / 2;
  parent.append(element("circle", { cx: x, cy: y, r: radius, fill: color, stroke: "#fffefa", "stroke-width": 3 }));
  if (photo) {
    const clipId = `portrait-${id}`;
    const clip = element("clipPath", { id: clipId });
    clip.append(element("circle", { cx: x, cy: y, r: radius - 2 }));
    defs.append(clip);
    parent.append(element("image", {
      x: x - radius + 2, y: y - radius + 2,
      width: diameter - 4, height: diameter - 4,
      href: photo, "clip-path": `url(#${clipId})`,
      preserveAspectRatio: "xMidYMid slice",
    }));
  } else {
    parent.append(element("circle", { cx: x, cy: y - diameter * .1, r: diameter * .13, fill: ink, opacity: .48 }));
    parent.append(element("path", {
      d: `M ${x - diameter * .28} ${y + diameter * .32} C ${x - diameter * .25} ${y + diameter * .02}, ${x + diameter * .25} ${y + diameter * .02}, ${x + diameter * .28} ${y + diameter * .32}`,
      fill: ink, opacity: .36,
    }));
  }
}

/** Standalone SVG: text and routes remain vectors, portraits are embedded. */
export async function createTreeSvg(tree: ExportTree, signal?: AbortSignal) {
  signal?.throwIfAborted();
  const people = tree.nodes.filter((node) => node.type === "person");
  if (!people.length) throw new Error("В древе пока нет людей.");
  const bounds = { left: Infinity, top: Infinity, right: -Infinity, bottom: -Infinity };
  for (const node of tree.nodes) {
    bounds.left = Math.min(bounds.left, node.position.x);
    bounds.top = Math.min(bounds.top, node.position.y);
    bounds.right = Math.max(bounds.right, node.position.x + (node.width || 220));
    bounds.bottom = Math.max(bounds.bottom, node.position.y + (node.height || 84));
  }
  for (const edge of tree.edges)
    for (const point of edge.data?.route?.points || []) {
      bounds.left = Math.min(bounds.left, point.x);
      bounds.top = Math.min(bounds.top, point.y);
      bounds.right = Math.max(bounds.right, point.x);
      bounds.bottom = Math.max(bounds.bottom, point.y);
    }
  const left = bounds.left - PADDING, top = bounds.top - PADDING;
  const width = Math.ceil(bounds.right - bounds.left + 2 * PADDING);
  const height = Math.ceil(bounds.bottom - bounds.top + 2 * PADDING);
  const scale = Math.min(1, MAX_DISPLAY_SIDE / width, MAX_DISPLAY_SIDE / height);
  const svg = element("svg", {
    xmlns: SVG, width: Math.round(width * scale), height: Math.round(height * scale),
    viewBox: `${left} ${top} ${width} ${height}`,
    role: "img", "aria-label": tree.title,
  });
  svg.append(element("title"));
  svg.firstElementChild!.textContent = tree.title;
  const defs = element("defs");
  svg.append(defs);
  svg.append(element("rect", {
    x: left, y: top, width, height, fill: tree.white ? "#fff" : "#f8f7f2",
  }));

  for (const node of tree.nodes) {
    if (node.type !== "household") continue;
    const { x, y } = node.position;
    const w = node.width || 0, h = node.height || 0;
    if (node.data.label) {
      svg.append(element("rect", {
        x, y, width: w, height: h, rx: 14,
        fill: "#eaf0e2", "fill-opacity": .16, stroke: "#dfe6d7",
      }));
      text(svg, node.data.label, x + 14, node.data.reverse ? y + 17 : y + h - 8, {
        fill: "#627657", "font-size": 12,
      });
    } else {
      svg.append(element("rect", {
        x: x + 18, y: y + 5, width: Math.max(0, w - 36),
        height: tree.actions.cardVariant === "portrait" ? 144 : Math.max(0, h - 10),
        rx: 30, fill: "#839777", "fill-opacity": .075,
      }));
    }
  }

  const nodeMap = new Map(people.map((node) => [node.id, node]));
  const markers = new Map<string, string>();
  for (const edge of tree.edges) {
    const route = edge.data?.route;
    const source = nodeMap.get(edge.source), target = nodeMap.get(edge.target);
    if (!source || !target) continue;
    const points = route?.points || [
      { x: source.position.x + (source.width || 220) / 2, y: source.position.y + (source.height || 84) / 2 },
      { x: target.position.x + (target.width || 220) / 2, y: target.position.y + (target.height || 84) / 2 },
    ];
    const rounded = roundedRoute(points);
    const color = String(edge.style?.stroke || "#58775a");
    const path = element("path", {
      d: edge.data?.path || rounded.path,
      fill: "none", stroke: color,
      "stroke-width": Number(edge.style?.strokeWidth || 1.6),
      "stroke-dasharray": edge.style?.strokeDasharray?.toString(),
      "stroke-linecap": "round", "stroke-linejoin": "round",
    });
    if (edge.markerEnd) {
      let marker = markers.get(color);
      if (!marker) {
        marker = `arrow-${markers.size}`;
        markers.set(color, marker);
        const shape = element("marker", {
          id: marker, markerWidth: 11, markerHeight: 10,
          refX: 9, refY: 5, orient: "auto", markerUnits: "userSpaceOnUse",
        });
        shape.append(element("path", { d: "M 0 1 L 9 5 L 0 9 Z", fill: color }));
        defs.append(shape);
      }
      path.setAttribute("marker-end", `url(#${marker})`);
    }
    svg.append(path);
    if (edge.data?.junction)
      svg.append(element("circle", {
        cx: edge.data.junction.x, cy: edge.data.junction.y,
        r: 2.4, fill: color,
      }));
    if (!["parent", "spouse"].includes(edge.data?.connection.type || "")) {
      const placement = edgeLabelPlacement(points, {
        x: rounded.x, y: rounded.y, source: points[0], target: points.at(-1)!,
      });
      const label = placement.reversed
        ? edge.data?.reverseLabel || edge.data?.label || ""
        : edge.data?.label || "";
      if (label) {
        const size = Math.min(230, Math.max(55, label.length * 6.5 + 14));
        const group = element("g", {
          transform: `translate(${placement.x} ${placement.y}) rotate(${placement.vertical ? 90 : 0})`,
        });
        group.append(element("rect", {
          x: -size / 2, y: -9, width: size, height: 18, rx: 6,
          fill: tree.white ? "#fff" : "#f8f7f2", "fill-opacity": .94,
        }));
        text(group, label, 0, 4, {
          "text-anchor": "middle", "font-size": 11, fill: color,
        });
        svg.append(group);
      }
    }
  }

  const photos = await embeddedPhotos(tree, signal);
  signal?.throwIfAborted();
  const measurement = document.createElement("canvas").getContext("2d")!;
  const relationLabels = new Map<string, string>();
  for (const [index, node] of people.entries()) {
    const person = node.data.person;
    const { x, y } = node.position;
    const w = node.width || 220, h = node.height || 84;
    const group = element("g", { "data-person-id": person.id });
    const portrait = tree.actions.cardVariant === "portrait";
    if (!portrait)
      group.append(element("rect", {
        x, y, width: w, height: h, rx: 8,
        fill: tree.white ? "#fff" : "#fffffd",
        stroke: node.selected || node.data.spotlit ? "#5c8650" : "#dce3d6",
        "stroke-width": node.selected || node.data.spotlit ? 2 : 1,
      }));
    const diameter = portrait ? 132 : 56;
    const centerX = portrait ? x + w / 2 : x + 35;
    const centerY = portrait ? y + 70 : y + h / 2;
    avatar(group, defs, String(index),
      centerX, centerY, diameter, photos.get(person.id), resolvedSex(person));
    if (portrait) {
      const lines = fittedLines(fullName(person), w - 16, 16, 3, measurement);
      let baseline = y + 161;
      for (const line of lines) {
        text(group, line, x + w / 2, baseline, {
          "text-anchor": "middle", "font-size": 16, "font-weight": 600, fill: "#26382d",
        });
        baseline += 18;
      }
      const lifespan = years(person);
      if (lifespan) {
        baseline += 2;
        text(group, lifespan, x + w / 2, baseline, {
          "text-anchor": "middle", "font-size": 12, fill: "#687565",
        });
        baseline += 16;
      }
      let relation = relationLabels.get(person.id);
      if (!relation) {
        relation = personRelationLabel(person, tree.actions.kinshipReference,
          tree.actions.kinshipPeople, tree.actions.kinshipLinks);
        relationLabels.set(person.id, relation);
      }
      for (const line of fittedLines(relation, w - 16, 14, 2, measurement)) {
        text(group, line, x + w / 2, baseline + 4, {
          "text-anchor": "middle", "font-size": 14, fill: "#566d58",
        });
        baseline += 16;
      }
    } else {
      const name = `${person.name} ${person.patronymic || ""}`.trim();
      text(group, fittedLines(person.surname || person.name, w - 82, 17, 1, measurement)[0] || "", x + 73, y + 27, {
        "font-size": 17, "font-weight": 600, fill: "#26382d",
      });
      if (person.surname)
        text(group, fittedLines(name, w - 82, 14, 1, measurement)[0] || "", x + 73, y + 47, {
          "font-size": 14, fill: "#26382d",
        });
      const lifespan = years(person);
      if (lifespan)
        text(group, lifespan, x + 73, y + 66, { "font-size": 12, fill: "#687565" });
    }
    svg.append(group);
  }
  return svg;
}

export async function exportTreeSvg(tree: ExportTree, signal?: AbortSignal) {
  const svg = await createTreeSvg(tree, signal);
  signal?.throwIfAborted();
  const contents = new XMLSerializer().serializeToString(svg);
  const url = URL.createObjectURL(new Blob([contents], { type: "image/svg+xml;charset=utf-8" }));
  const link = document.createElement("a");
  link.href = url;
  link.download = `${tree.title.replace(/[^\p{L}\p{N} ._()-]/gu, " ").trim() || "Древо"}.svg`;
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}
