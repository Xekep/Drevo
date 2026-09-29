import { useEffect } from "react";
import { createRoot } from "react-dom/client";
import { safeUrl } from "../../domain";
import {
  ReactFlow,
  ReactFlowProvider,
  ConnectionMode,
  useNodesInitialized,
} from "@xyflow/react";
import { PersonNode, TreeActions, type PersonNodeType } from "./person-node";
import { HouseholdNode, type HouseholdNodeType } from "./household-node";
import {
  RelationshipEdge,
  type RelationshipEdgeType,
} from "./relationship-edge";
import {
  preparePdfFont,
  downloadTreeVectorPdf,
  downloadTreePng,
} from "./tree-pdf-vector";
import { treeGraphicBounds } from "./tree-print-plan";

export type ExportTree = {
  nodes: Array<PersonNodeType | HouseholdNodeType>;
  edges: RelationshipEdgeType[];
  actions: React.ContextType<typeof TreeActions>;
  title: string;
  white: boolean;
};
const nodeTypes = { person: PersonNode, household: HouseholdNode };
const edgeTypes = { relationship: RelationshipEdge };

function Ready({ onReady }: { onReady: () => void }) {
  const initialized = useNodesInitialized();
  useEffect(() => {
    if (!initialized) return;
    // Edges use measured handles, so wait for the commit after node measurement.
    const timer = setTimeout(onReady, 100);
    return () => clearTimeout(timer);
  }, [initialized, onReady]);
  return null;
}

function PrintTree({
  nodes,
  edges,
  white,
  width,
  height,
  x,
  y,
  onReady,
}: ExportTree & {
  width: number;
  height: number;
  x: number;
  y: number;
  onReady: () => void;
}) {
  return (
    <div
      className={`tree-canvas tree-print-canvas ${white ? "theme-white" : ""} has-portrait-cards`}
      style={{ width, height }}
    >
      <ReactFlowProvider>
        <ReactFlow<PersonNodeType | HouseholdNodeType, RelationshipEdgeType>
          defaultNodes={nodes}
          defaultEdges={edges}
          nodeTypes={nodeTypes}
          edgeTypes={edgeTypes}
          connectionMode={ConnectionMode.Loose}
          defaultViewport={{ x, y, zoom: 1 }}
          minZoom={1}
          maxZoom={1}
          nodesDraggable={false}
          nodesConnectable={false}
          nodesFocusable={false}
          edgesFocusable={false}
          elementsSelectable={false}
          deleteKeyCode={null}
          selectionKeyCode={null}
          zoomActivationKeyCode={null}
          panActivationKeyCode={null}
          panOnDrag={false}
          zoomOnScroll={false}
          zoomOnPinch={false}
          zoomOnDoubleClick={false}
          onlyRenderVisibleElements={false}
          proOptions={{ hideAttribution: true }}
        >
          <Ready onReady={onReady} />
        </ReactFlow>
      </ReactFlowProvider>
    </div>
  );
}

/** Download the active tree projection, including nodes outside the camera.
 * Explicit vector PDF geometry is independent of browser printer preferences.
 */
async function exportTreeGraphic(
  tree: ExportTree,
  format: "pdf" | "png",
  signal?: AbortSignal,
) {
  signal?.throwIfAborted();
  const work = new AbortController();
  const { width, height, x, y } = treeGraphicBounds(tree);
  // Browsers cannot allocate a bitmap for a full large archive. Vector PDF
  // remains available; PNG is intended for a selected, publication-sized area.
  if (
    format === "png" &&
    (width > 8192 || height > 8192 || width * height > 18_000_000)
  )
    throw new Error(
      "Для PNG область слишком велика. Выберите ветку или сохраните всё древо в PDF.",
    );
  const iframe = document.createElement("iframe");
  iframe.title = format === "pdf" ? "PDF древа" : "PNG древа";
  iframe.name = `drevo-${format}`;
  iframe.dataset.treePrint = "";
  iframe.setAttribute("aria-hidden", "true");
  // Keep the print viewport underneath the app so its layout can be measured.
  iframe.style.cssText = `position:fixed;left:0;top:0;width:${width}px;height:${height}px;border:0;pointer-events:none;opacity:0;z-index:-1`;
  document.body.append(iframe);
  const target = iframe.contentDocument!;
  // about:blank starts in quirks mode, which ignores the intended body/page
  // dimensions on custom-sized sheets.
  target.open();
  target.write("<!doctype html><html><head></head><body></body></html>");
  target.close();
  target.title = tree.title;
  target.documentElement.lang = "ru";
  const charset = target.createElement("meta");
  charset.setAttribute("charset", "utf-8");
  target.head.prepend(charset);
  const viewport = target.createElement("meta");
  viewport.name = "viewport";
  viewport.content = "width=device-width, initial-scale=1";
  target.head.append(viewport);
  const referrer = target.createElement("meta");
  referrer.name = "referrer";
  referrer.content = "no-referrer";
  target.head.append(referrer);
  const base = target.createElement("base");
  base.href = `${window.location.origin}/`;
  target.head.append(base);
  const root = createRoot(target.body);
  let disposed = false;
  let expiry: ReturnType<typeof setTimeout> | undefined;
  const dispose = () => {
    if (disposed) return;
    disposed = true;
    work.abort();
    clearTimeout(expiry);
    signal?.removeEventListener("abort", abort);
    root.unmount();
    iframe.remove();
  };
  let rejectAbort: (reason: unknown) => void;
  const cancelled = new Promise<never>((_, reject) => {
    rejectAbort = reject;
  });
  const abort = () => {
    rejectAbort(signal?.reason);
    dispose();
  };
  signal?.addEventListener("abort", abort, { once: true });
  try {
    const prepared = (async () => {
      const font = await preparePdfFont(target, work.signal);
      // Use the actual app styles and fonts instead of maintaining PDF card layouts.
      await Promise.all(
        Array.from(
          document.querySelectorAll('link[rel="stylesheet"], style'),
          (element) => {
            const copy = element.cloneNode(true) as
              HTMLLinkElement | HTMLStyleElement;
            const loaded =
              copy instanceof HTMLLinkElement
                ? new Promise<void>((resolve, reject) => {
                    copy.onload = () => resolve();
                    copy.onerror = () =>
                      reject(
                        new Error("Не удалось загрузить оформление древа."),
                      );
                  })
                : Promise.resolve();
            target.head.append(copy);
            return loaded;
          },
        ),
      );
      if (disposed) return;
      const styles = target.createElement("style");
      styles.textContent = `
      @page { size: ${width}px ${height}px; margin: 0; }
      html, body { margin: 0 !important; padding: 0 !important; width: ${width}px !important; height: ${height}px !important; overflow: hidden !important; background: #fff !important; }
      * { animation: none !important; transition: none !important; print-color-adjust: exact !important; -webkit-print-color-adjust: exact !important; }
      .tree-print-canvas * { font-family: Drevo, sans-serif !important; font-weight: 400 !important; }
      .tree-print-canvas { position: absolute !important; inset: 0 auto auto 0 !important; background: transparent !important; }
      .tree-print-canvas .react-flow { background: transparent !important; }
      .react-flow__handle { visibility: hidden !important; }
      .react-flow__panel, .react-flow__attribution { display: none !important; }
      .flow-collapse, .flow-expand-family, .flow-reference { display: none !important; }
    `;
      target.head.append(styles);
      const ready = new Promise<void>((resolve) => {
        root.render(
          <TreeActions.Provider value={tree.actions}>
            <PrintTree
              {...tree}
              width={width}
              height={height}
              x={x}
              y={y}
              onReady={resolve}
            />
          </TreeActions.Provider>,
        );
      });
      // Timeout cleans up failed exports and aborts any later download.
      await ready;
      const photos = new Map(
        tree.nodes.flatMap((node) =>
          node.type === "person"
            ? [[node.data.person.id, safeUrl(node.data.person.photo)] as const]
            : [],
        ),
      );
      await Promise.all(
        Array.from(target.images, async (image) => {
          image.loading = "eager";
          const id =
            image.closest<HTMLElement>(".flow-person")?.dataset.personId;
          const original = id ? photos.get(id) : undefined;
          if (original) image.src = original;
          if (image.src) await image.decode();
        }),
      );
      await target.fonts.ready;
      if (disposed) return;
      for (const label of target.querySelectorAll(".portrait-card-info small"))
        if (label.textContent?.trim() === "Нет привязки к древу")
          label.remove();
      // Freeze measured HTML/SVG for vector serialization. React Flow listeners
      // and further handle measurements are no longer needed.
      const snapshot = target.body.firstElementChild!.cloneNode(true);
      root.unmount();
      target.body.replaceChildren(snapshot);
      await Promise.all(Array.from(target.images, (image) => image.decode()));
      if (!disposed) {
        if (format === "pdf")
          await downloadTreeVectorPdf(
            target,
            width,
            height,
            tree.title,
            font,
            work.signal,
          );
        else
          await downloadTreePng(
            target,
            width,
            height,
            tree.title,
            font,
            work.signal,
          );
      }
    })();
    await Promise.race([
      prepared,
      cancelled,
      new Promise<never>((_, reject) => {
        expiry = setTimeout(
          () => reject(new Error("Подготовка файла заняла слишком долго.")),
          30_000,
        );
      }),
    ]);
    clearTimeout(expiry);
    dispose();
  } catch (error) {
    dispose();
    throw error;
  }
}

export const exportTreePdf = (tree: ExportTree, signal?: AbortSignal) =>
  exportTreeGraphic(tree, "pdf", signal);

export const exportTreePng = (tree: ExportTree, signal?: AbortSignal) =>
  exportTreeGraphic(tree, "png", signal);
