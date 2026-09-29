import { createRoot } from "react-dom/client";
import { flushSync } from "react-dom";
import { jsPDF } from "jspdf";
import "svg2pdf.js";
import type { Family } from "../../domain";
import { FanChart } from "./fan-chart";
import { base64, downloadBlob, preparePdfFont } from "./tree-pdf-vector";

export type FanExportOptions = {
  generations: number;
  names: boolean;
  years: boolean;
  portraits: boolean;
  unknown: boolean;
  format: "pdf" | "png";
};

const SVG_NAMESPACE = "http://www.w3.org/2000/svg";

/** Export the same fan sectors used by the viewer, with selectable details. */
export async function exportFan(
  family: Family,
  anchorId: string,
  options: FanExportOptions,
  signal?: AbortSignal,
) {
  if (!family.people.some((person) => person.id === anchorId))
    throw new Error("Выберите человека для экспорта веера.");
  signal?.throwIfAborted();
  const host = document.createElement("div");
  host.style.cssText =
    "position:fixed;left:0;top:0;width:1600px;height:900px;opacity:0;pointer-events:none;z-index:-1";
  document.body.append(host);
  const root = createRoot(host);
  try {
    flushSync(() =>
      root.render(
        <FanChart
          family={family}
          anchorId={anchorId}
          selected={[]}
          onChoose={() => {}}
          generations={options.generations}
          showNames={options.names}
          showYears={options.years}
          showPortraits={options.portraits}
          showUnknown={options.unknown}
        />,
      ),
    );
    const original = host.querySelector<SVGSVGElement>(".fan-chart-svg");
    if (!original) throw new Error("Не удалось построить веер.");
    const svg = original.cloneNode(true) as SVGSVGElement;
    const viewBox = original.viewBox.baseVal;
    const width = Math.ceil(viewBox.width);
    const height = Math.ceil(viewBox.height);
    svg.setAttribute("width", String(width));
    svg.setAttribute("height", String(height));
    svg.setAttribute("xmlns", SVG_NAMESPACE);
    const background = document.createElementNS(SVG_NAMESPACE, "rect");
    background.setAttribute("x", String(viewBox.x));
    background.setAttribute("y", String(viewBox.y));
    background.setAttribute("width", String(width));
    background.setAttribute("height", String(height));
    background.setAttribute("fill", "#fff");
    svg.prepend(background);
    const sources = [original, ...original.querySelectorAll("*")];
    const copies = [svg, ...svg.querySelectorAll("*")].filter(
      (item) => item !== background,
    );
    for (let index = 0; index < sources.length; index++) {
      const style = getComputedStyle(sources[index]);
      const copy = copies[index];
      if (!copy) continue;
      for (const property of [
        "fill",
        "stroke",
        "stroke-width",
        "stroke-dasharray",
        "opacity",
        "font-size",
        "vector-effect",
      ])
        if (style.getPropertyValue(property))
          copy.setAttribute(property, style.getPropertyValue(property));
      if (
        copy.tagName.toLowerCase() === "text" ||
        copy.tagName.toLowerCase() === "tspan"
      ) {
        copy.setAttribute("font-family", "Drevo");
        copy.setAttribute("font-weight", "normal");
      }
    }
    const font = await preparePdfFont(document, signal);
    for (const image of svg.querySelectorAll<SVGImageElement>("image")) {
      const url = image.getAttribute("href");
      if (!url) continue;
      try {
        const response = await fetch(url, { signal });
        if (!response.ok) throw new Error("Портрет недоступен");
        const blob = await response.blob();
        if (!blob.type.startsWith("image/") || blob.size > 5 * 1024 * 1024)
          throw new Error("Портрет не является изображением");
        const bytes = new Uint8Array(await blob.arrayBuffer());
        image.setAttribute("href", `data:${blob.type};base64,${base64(bytes)}`);
      } catch {
        if (signal?.aborted) signal.throwIfAborted();
        image.remove();
      }
    }
    signal?.throwIfAborted();
    const title = `Веер предков · ${family.people.find((person) => person.id === anchorId)!.name}`;
    if (options.format === "pdf") {
      const pdf = new jsPDF({
        orientation: "landscape",
        unit: "pt",
        format: [(width + 48) * 0.75, (height + 48) * 0.75],
        compress: true,
      });
      pdf.addFileToVFS("Drevo.ttf", base64(font));
      pdf.addFont("Drevo.ttf", "Drevo", "normal");
      pdf.setFont("Drevo");
      pdf.setProperties({ title, creator: "Drevo" });
      await pdf.svg(svg, {
        x: 18,
        y: 18,
        width: width * 0.75,
        height: height * 0.75,
      });
      signal?.throwIfAborted();
      downloadBlob(pdf.output("blob"), title, "pdf");
    } else {
      const style = document.createElementNS(SVG_NAMESPACE, "style");
      style.textContent = `@font-face{font-family:Drevo;src:url(data:font/ttf;base64,${base64(font)}) format('truetype')}`;
      svg.prepend(style);
      const source = URL.createObjectURL(
        new Blob([new XMLSerializer().serializeToString(svg)], {
          type: "image/svg+xml;charset=utf-8",
        }),
      );
      try {
        const image = new Image();
        image.src = source;
        await image.decode();
        const canvas = document.createElement("canvas");
        canvas.width = width * 2;
        canvas.height = height * 2;
        const context = canvas.getContext("2d");
        if (!context) throw new Error("Браузер не смог подготовить PNG.");
        context.fillStyle = "#fff";
        context.fillRect(0, 0, canvas.width, canvas.height);
        context.drawImage(image, 0, 0, canvas.width, canvas.height);
        const blob = await new Promise<Blob>((resolve, reject) =>
          canvas.toBlob(
            (value) =>
              value
                ? resolve(value)
                : reject(new Error("Не удалось создать PNG.")),
            "image/png",
          ),
        );
        canvas.width = canvas.height = 0;
        signal?.throwIfAborted();
        downloadBlob(blob, title, "png");
      } finally {
        URL.revokeObjectURL(source);
      }
    }
  } finally {
    root.unmount();
    host.remove();
  }
}
