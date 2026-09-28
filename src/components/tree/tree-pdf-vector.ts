import { jsPDF } from "jspdf";
import "svg2pdf.js";
import fontUrl from "../../../assets/DejaVuSans.ttf?url";

const namespace = "http://www.w3.org/2000/svg";
const fontName = "Drevo";

export async function preparePdfFont(target: Document, signal?: AbortSignal) {
  const response = await fetch(fontUrl, { signal });
  if (!response.ok) throw new Error("Не удалось загрузить шрифт PDF.");
  const bytes = new Uint8Array(await response.arrayBuffer());
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
export function treePdfSvg(target: Document, width: number, height: number) {
  const view = target.defaultView!;
  const svg = svgElement(target, "svg", {
    width,
    height,
    viewBox: `0 0 ${width} ${height}`,
  });
  const styles = (element: Element) => view.getComputedStyle(element);
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
      // Browser ranges retain actual wrapping and letter positions, including
      // Cyrillic names; no second text-layout algorithm to drift from the cards.
      for (let index = 0; index < node.textContent.length; index++) {
        range.setStart(node, index);
        range.setEnd(node, index + 1);
        const rect = range.getBoundingClientRect();
        if (
          !rect.width ||
          rect.top >= clip.bottom ||
          rect.right > clip.right + 1
        )
          continue;
        const last = lines.at(-1);
        if (last && Math.abs(last.y - rect.y) < 1)
          last.value += node.textContent[index];
        else
          lines.push({ value: node.textContent[index], x: rect.x, y: rect.y });
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
  for (const household of target.querySelectorAll(".flow-household")) {
    box(household, svg);
    text(household, svg);
  }
  for (const edges of target.querySelectorAll<SVGSVGElement>(
    ".react-flow__edges > svg",
  )) {
    if (edges.classList.contains("react-flow__marker")) {
      const defs = edges.querySelector("defs");
      if (defs) svg.append(defs.cloneNode(true));
    } else nativeSvg(edges, svg);
  }
  for (const person of target.querySelectorAll(".flow-person")) {
    box(person, svg);
    const avatar = person.querySelector<HTMLElement>(".person-avatar");
    if (avatar) {
      box(avatar, svg);
      const image = avatar.querySelector("img");
      if (image) {
        const bounds = image.getBoundingClientRect();
        // Only the photograph is raster. Bound memory to one small portrait,
        // preserving much more detail than its screen-sized thumbnail.
        const canvas = target.createElement("canvas");
        canvas.width = canvas.height = Math.min(
          1024,
          Math.max(256, Math.min(image.naturalWidth, image.naturalHeight)),
        );
        const context = canvas.getContext("2d")!;
        const crop = Math.min(image.naturalWidth, image.naturalHeight);
        context.beginPath();
        context.arc(
          canvas.width / 2,
          canvas.height / 2,
          canvas.width / 2,
          0,
          2 * Math.PI,
        );
        context.clip();
        context.drawImage(
          image,
          (image.naturalWidth - crop) / 2,
          (image.naturalHeight - crop) / 2,
          crop,
          crop,
          0,
          0,
          canvas.width,
          canvas.height,
        );
        svg.append(
          svgElement(target, "image", {
            x: bounds.x,
            y: bounds.y,
            width: bounds.width,
            height: bounds.height,
            href: canvas.toDataURL("image/png"),
          }),
        );
        canvas.width = canvas.height = 0;
      } else
        for (const placeholder of avatar.querySelectorAll<SVGSVGElement>("svg"))
          nativeSvg(placeholder, svg);
    }
    const content = person.querySelector(".flow-person-content");
    if (content) text(content, svg);
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
    svg.append(group);
    anchor.style.transform = transform;
  }
  return svg;
}

export async function downloadTreeVectorPdf(
  target: Document,
  width: number,
  height: number,
  title: string,
  font: Uint8Array,
  signal?: AbortSignal,
) {
  signal?.throwIfAborted();
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
  let binary = "";
  for (let offset = 0; offset < font.length; offset += 8192)
    binary += String.fromCharCode(...font.subarray(offset, offset + 8192));
  pdf.addFileToVFS("Drevo.ttf", btoa(binary));
  pdf.addFont("Drevo.ttf", fontName, "normal");
  pdf.setFont(fontName);
  pdf.setProperties({ title, creator: "Drevo" });
  const svg = treePdfSvg(target, width, height);
  await pdf.svg(svg, {
    width: (width * 0.75) / userUnit,
    height: (height * 0.75) / userUnit,
  });
  signal?.throwIfAborted();
  const url = URL.createObjectURL(pdf.output("blob"));
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
