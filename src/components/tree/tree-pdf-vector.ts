import { archiveFetch } from "../../data/archive-fetch.ts";
import { jsPDF } from "jspdf";
import "svg2pdf.js";
import fontUrl from "../../../assets/DejaVuSans.ttf?url";
import { drawPdfPortraits, yieldPdfExport, type PdfPortraitPlacement } from "./tree-pdf-images";
import {
  DEFAULT_TREE_PRINT,
  treePrintPlan,
  type TreePrintOptions,
} from "./tree-print-plan";

const namespace = "http://www.w3.org/2000/svg";
const fontName = "Drevo";

function downloadBlob(blob: Blob, title: string) {
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  const filename = Array.from(title, (char) =>
    char.charCodeAt(0) < 32 ? "_" : char,
  ).join("");
  link.download = `${filename.replace(/[<>:"/\\|?*]/g, "_").slice(0, 120) || "Древо"}.pdf`;
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

function base64(bytes: Uint8Array) {
  let binary = "";
  for (let offset = 0; offset < bytes.length; offset += 8192)
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 8192));
  return btoa(binary);
}

async function loadPdfFontBytes(signal?: AbortSignal) {
  const response = await archiveFetch(fontUrl, { signal });
  if (!response.ok) throw new Error("Не удалось загрузить шрифт PDF.");
  return new Uint8Array(await response.arrayBuffer());
}

export async function preparePdfFont(target: Document, signal?: AbortSignal) {
  const bytes = await loadPdfFontBytes(signal);
  const face = new FontFace(fontName, bytes);
  await face.load();
  target.fonts.add(face);
  return bytes;
}

function svgElement<K extends keyof SVGElementTagNameMap>(
  document: Document,
  name: K,
  attributes: Record<string, string | number> = {},
) {
  const element = document.createElementNS(namespace, name);
  for (const [key, value] of Object.entries(attributes))
    element.setAttribute(key, String(value));
  return element;
}

/** A vector scene from the already measured, full-detail tree. No foreignObject,
 * HTML screenshot, remote converter, or archive-sized bitmap is involved.
 */
async function treePdfSvg(
  target: Document,
  width: number,
  height: number,
  portraits: ReadonlyMap<string, string>,
  layers?: { portraits: PdfPortraitPlacement[]; foreground: SVGSVGElement },
  signal?: AbortSignal,
  onProgress?: () => void,
) {
  signal?.throwIfAborted();
  const view = target.defaultView!;
  const svg = svgElement(target, "svg", {
    width,
    height,
    viewBox: `0 0 ${width} ${height}`,
  });
  const computedStyles = new WeakMap<Element, CSSStyleDeclaration>();
  const styles = (element: Element) => {
    let style = computedStyles.get(element);
    if (!style) {
      style = view.getComputedStyle(element);
      computedStyles.set(element, style);
    }
    return style;
  };
  const visible = (element: Element) => {
    const style = styles(element);
    return (
      style.display !== "none" &&
      style.visibility !== "hidden" &&
      Number(style.opacity) !== 0
    );
  };
  function box(element: Element, parent: SVGElement) {
    if (!visible(element)) return;
    const bounds = element.getBoundingClientRect(),
      style = styles(element);
    const border = parseFloat(style.borderTopWidth) || 0;
    parent.append(
      svgElement(target, "rect", {
        x: bounds.x,
        y: bounds.y,
        width: bounds.width,
        height: bounds.height,
        rx: Math.min(
          parseFloat(style.borderTopLeftRadius) || 0,
          bounds.width / 2,
          bounds.height / 2,
        ),
        fill: style.backgroundColor,
        stroke: border ? style.borderTopColor : "none",
        "stroke-width": border,
      }),
    );
  }
  function nativeSvg(element: SVGSVGElement, parent: SVGElement) {
    if (!visible(element)) return;
    const bounds = element.getBoundingClientRect();
    const clone = element.cloneNode(true) as SVGSVGElement;
    const sources = [element, ...element.querySelectorAll("*")];
    const copies = [clone, ...clone.querySelectorAll("*")];
    sources.forEach((source, index) => {
      const copy = copies[index];
      const style = styles(source);
      copy.removeAttribute("style");
      for (const property of [
        "fill",
        "stroke",
        "stroke-width",
        "stroke-dasharray",
        "stroke-linecap",
        "stroke-linejoin",
        "opacity",
        "fill-opacity",
        "stroke-opacity",
        "visibility",
        "display",
        "color",
      ])
        copy.setAttribute(property, style.getPropertyValue(property));
      // Computed marker URLs can be absolute about:blank URLs. Keep SVG-local IDs.
      for (const property of ["marker-start", "marker-end"])
        if (source.hasAttribute(property))
          copy.setAttribute(property, source.getAttribute(property)!);
    });
    clone
      .querySelectorAll(
        ".react-flow__edge-interaction, .tree-edge-growth-path, [display='none']",
      )
      .forEach((node) => node.remove());
    clone.setAttribute("x", String(bounds.x));
    clone.setAttribute("y", String(bounds.y));
    clone.setAttribute("width", String(bounds.width));
    clone.setAttribute("height", String(bounds.height));
    clone.setAttribute("overflow", "visible");
    parent.append(clone);
  }
  function text(element: Element, parent: SVGElement) {
    const walker = target.createTreeWalker(element, NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      const owner = node.parentElement!;
      if (
        owner.namespaceURI === namespace ||
        !visible(owner) ||
        !node.textContent?.trim()
      )
        continue;
      const style = styles(owner),
        range = target.createRange();
      const fontSize = parseFloat(style.fontSize);
      const clip = owner.getBoundingClientRect();
      const lines: { value: string; x: number; y: number }[] = [];
      range.selectNodeContents(node);
      const rects = range.getClientRects();
      const single = rects.length === 1 ? rects[0] : undefined;
      if (
        single?.width &&
        single.top + fontSize * 0.93 <= clip.bottom + 1 &&
        single.right <= clip.right + 1
      ) {
        // Dates and short labels usually fit one line. One range gives exactly
        // the same browser placement without a measurement for every character.
        lines.push({ value: node.textContent, x: single.x, y: single.y });
      } else {
        // Browser ranges retain actual wrapping and letter positions, including
        // Cyrillic names; no second text-layout algorithm to drift from the cards.
        for (let index = 0; index < node.textContent.length; index++) {
          range.setStart(node, index);
          range.setEnd(node, index + 1);
          const rect = range.getBoundingClientRect();
          if (
            !rect.width ||
            rect.top + fontSize * 0.93 > clip.bottom + 1 ||
            rect.right > clip.right + 1
          )
            continue;
          const last = lines.at(-1);
          if (last && Math.abs(last.y - rect.y) < 1)
            last.value += node.textContent[index];
          else
            lines.push({
              value: node.textContent[index],
              x: rect.x,
              y: rect.y,
            });
        }
      }
      for (const line of lines) {
        const label = svgElement(target, "text", {
          x: line.x,
          y: line.y + fontSize * 0.93,
          "font-family": fontName,
          "font-size": fontSize,
          "font-weight": "normal",
          fill: style.color,
        });
        label.textContent = line.value;
        parent.append(label);
      }
    }
  }
  let completed = 0;
  for (const household of target.querySelectorAll(".flow-household")) {
    box(household, svg);
    text(household, svg);
    if (++completed % 64 === 0) { onProgress?.(); await yieldPdfExport(signal); }
  }
  for (const edges of target.querySelectorAll<SVGSVGElement>(
    ".react-flow__edges > svg",
  )) {
    if (edges.classList.contains("react-flow__marker")) {
      const defs = edges.querySelector("defs");
      if (defs) svg.append(defs.cloneNode(true));
    } else nativeSvg(edges, svg);
    if (++completed % 64 === 0) { onProgress?.(); await yieldPdfExport(signal); }
  }
  for (const person of target.querySelectorAll(".flow-person")) {
    box(person, svg);
    const avatar = person.querySelector<HTMLElement>(".person-avatar");
    if (avatar) {
      const portrait = portraits.get(
        (person as HTMLElement).dataset.personId || "",
      );
      if (portrait) {
        const bounds = avatar.getBoundingClientRect();
        const style = styles(avatar);
        const left =
          parseFloat(style.borderLeftWidth) + parseFloat(style.paddingLeft);
        const top =
          parseFloat(style.borderTopWidth) + parseFloat(style.paddingTop);
        const right =
          parseFloat(style.borderRightWidth) + parseFloat(style.paddingRight);
        const bottom =
          parseFloat(style.borderBottomWidth) + parseFloat(style.paddingBottom);
        const placement = { data: portrait, x: bounds.x + left, y: bounds.y + top,
          width: bounds.width - left - right, height: bounds.height - top - bottom };
        if (layers) layers.portraits.push(placement);
        else svg.append(svgElement(target, "image", { x: placement.x, y: placement.y,
          width: placement.width, height: placement.height, href: portrait }));
      } else {
        box(avatar, svg);
        for (const placeholder of avatar.querySelectorAll<SVGSVGElement>("svg"))
          nativeSvg(placeholder, svg);
      }
    }
    const content = person.querySelector(".flow-person-content");
    if (content) text(content, layers?.foreground || svg);
    if (++completed % 64 === 0) { onProgress?.(); await yieldPdfExport(signal); }
  }
  for (const anchor of target.querySelectorAll<HTMLElement>(
    ".tree-edge-label-anchor",
  )) {
    const label = anchor.querySelector(".flow-edge-label");
    if (!label) continue;
    const matrix = new DOMMatrix(styles(anchor).transform);
    const angle = (Math.atan2(matrix.b, matrix.a) * 180) / Math.PI;
    const transform = anchor.style.transform;
    // Measure unrotated text, then apply the same rotation in vector space.
    anchor.style.transform = `translate(${matrix.e}px,${matrix.f}px)`;
    const pivot = anchor.getBoundingClientRect();
    const group = svgElement(target, "g", {
      transform: `rotate(${angle} ${pivot.x} ${pivot.y})`,
    });
    box(label, group);
    text(label, group);
    (layers?.foreground || svg).append(group);
    anchor.style.transform = transform;
    if (++completed % 64 === 0) { onProgress?.(); await yieldPdfExport(signal); }
  }
  if (completed % 64) onProgress?.();
  return svg;
}

/** Bound svg2pdf's uninterrupted work while retaining a single vector page. */
async function renderVectorLayer(pdf: jsPDF, svg: SVGSVGElement,
  width: number, height: number, signal?: AbortSignal, onProgress?: () => void) {
  const children = Array.from(svg.children);
  const definitions = children.filter(child => child.localName === "defs");
  const drawing = children.filter(child => child.localName !== "defs");
  for (let offset = 0; offset < drawing.length; offset += 256) {
    signal?.throwIfAborted();
    const chunk = svg.cloneNode(false) as SVGSVGElement;
    for (const definition of definitions) chunk.append(definition.cloneNode(true));
    chunk.append(...drawing.slice(offset, offset + 256));
    await pdf.svg(chunk, { width, height });
    onProgress?.();
    await yieldPdfExport(signal);
  }
}

export async function downloadTreeVectorPdf(
  target: Document,
  width: number,
  height: number,
  title: string,
  font: Uint8Array,
  signal?: AbortSignal,
  portraits: ReadonlyMap<string, string> = new Map(),
  options: TreePrintOptions = DEFAULT_TREE_PRINT,
  onProgress?: () => void,
) {
  signal?.throwIfAborted();
  const plan = treePrintPlan(width, height, options);
  if (options.paper !== "large") {
    const pdf = new jsPDF({
      orientation: options.orientation,
      unit: "pt",
      format: [plan.widthPt, plan.heightPt],
      compress: true,
      putOnlyUsedFonts: true,
    });
    pdf.addFileToVFS("Drevo.ttf", base64(font));
    pdf.addFont("Drevo.ttf", fontName, "normal");
    pdf.setFont(fontName);
    pdf.setProperties({ title, creator: "Drevo" });
    const svg = await treePdfSvg(target, width, height, portraits, undefined, signal, onProgress);
    const usableWidth = plan.widthPt - 2 * plan.marginPt;
    const usableHeight = plan.heightPt - 2 * plan.marginPt;
    const tileWidth = usableWidth / (0.75 * plan.scale);
    const tileHeight = usableHeight / (0.75 * plan.scale);
    for (let row = 0; row < plan.rows; row++)
      for (let column = 0; column < plan.columns; column++) {
        signal?.throwIfAborted();
        if (row || column)
          pdf.addPage([plan.widthPt, plan.heightPt], options.orientation);
        const tile = svg.cloneNode(true) as SVGSVGElement;
        tile.setAttribute(
          "viewBox",
          `${column * tileWidth} ${row * tileHeight} ${tileWidth} ${tileHeight}`,
        );
        tile.setAttribute("width", String(tileWidth));
        tile.setAttribute("height", String(tileHeight));
        await pdf.svg(tile, {
          x: plan.marginPt,
          y: plan.marginPt,
          width: usableWidth,
          height: usableHeight,
        });
        onProgress?.();
      }
    signal?.throwIfAborted();
    await yieldPdfExport(signal);
    const blob = pdf.output("blob");
    onProgress?.();
    await yieldPdfExport(signal);
    downloadBlob(blob, title);
    return;
  }
  // PDF page coordinates are limited to 14,400 points. UserUnit preserves the
  // physical scale of very wide trees instead of shrinking their text.
  const userUnit = Math.max(
    1,
    Math.ceil((Math.max(width, height) * 0.75) / 14400),
  );
  const pdf = new jsPDF({
    orientation: "landscape",
    unit: "pt",
    format: [(width * 0.75) / userUnit, (height * 0.75) / userUnit],
    userUnit,
    compress: true,
    putOnlyUsedFonts: true,
  });
  // jsPDF's UserUnit option does not raise its default 1.3 header. UserUnit is
  // defined since PDF 1.6; this setter is present in the pinned jsPDF version.
  (
    pdf as unknown as {
      __private__: { setPdfVersion: (version: string) => void };
    }
  ).__private__.setPdfVersion("1.7");
  pdf.addFileToVFS("Drevo.ttf", base64(font));
  pdf.addFont("Drevo.ttf", fontName, "normal");
  pdf.setFont(fontName);
  pdf.setProperties({ title, creator: "Drevo" });
  const scale = 0.75 / userUnit;
  const layers = { portraits: [] as PdfPortraitPlacement[], foreground: svgElement(target, "svg", {
    width, height, viewBox: `0 0 ${width} ${height}`,
  }) };
  const svg = await treePdfSvg(target, width, height, portraits, layers, signal, onProgress);
  await renderVectorLayer(pdf, svg, width * scale, height * scale, signal, onProgress);
  await drawPdfPortraits(pdf, layers.portraits, scale, signal, onProgress);
  await renderVectorLayer(pdf, layers.foreground, width * scale, height * scale, signal, onProgress);
  await yieldPdfExport(signal);
  const blob = pdf.output("blob");
  onProgress?.();
  // output() is synchronous; let an elapsed cancellation/deadline run before
  // creating the download link, so a timed-out export cannot arrive late.
  await yieldPdfExport(signal);
  downloadBlob(blob, title);
}
