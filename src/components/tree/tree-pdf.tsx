import { useContext, useEffect } from "react";
import { createRoot } from "react-dom/client";
import { safeUrl } from "../../domain";
import {
  ReactFlow,
  ReactFlowProvider,
  ConnectionMode,
  getNodesBounds,
  useNodesInitialized,
} from "@xyflow/react";
import { PersonNode, TreeActions, type PersonNodeType } from "./person-node";
import { HouseholdNode, type HouseholdNodeType } from "./household-node";
import {
  RelationshipEdge,
  type RelationshipEdgeType,
} from "./relationship-edge";

export type ExportTree = {
  nodes: Array<PersonNodeType | HouseholdNodeType>;
  edges: RelationshipEdgeType[];
  actions: React.ContextType<typeof TreeActions>;
  title: string;
  white: boolean;
};
const nodeTypes = { person: PersonNode, household: HouseholdNode };
const edgeTypes = { relationship: RelationshipEdge };
const MAX_PAGE_SIDE = 19_000; // Below PDF's 200-inch page limit at 96 CSS px/in.

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
  const actions = useContext(TreeActions);
  return (
    <div
      className={`tree-canvas tree-print-canvas ${white ? "theme-white" : ""} ${actions.cardVariant === "portrait" ? "has-portrait-cards" : ""}`}
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

/** Print the active tree projection, including nodes outside the screen camera.
 * Chromium's PDF printer keeps HTML text and SVG paths vector, without an
 * archive-sized canvas or a server-side copy of private family data.
 */
export async function exportTreePdf(tree: ExportTree, signal?: AbortSignal) {
  signal?.throwIfAborted();
  if (!tree.nodes.length) throw new Error("В древе пока нет людей.");
  const bounds = getNodesBounds(tree.nodes);
  let left = bounds.x,
    top = bounds.y;
  let right = bounds.x + bounds.width,
    bottom = bounds.y + bounds.height;
  // Relationship routes can leave node bounds (e.g. additional relationships).
  for (const edge of tree.edges)
    for (const point of edge.data?.route?.points || []) {
      left = Math.min(left, point.x);
      top = Math.min(top, point.y);
      right = Math.max(right, point.x);
      bottom = Math.max(bottom, point.y);
    }
  const padding = 48;
  const width = Math.ceil(right - left + 2 * padding);
  const height = Math.ceil(bottom - top + 2 * padding);
  const scale = Math.min(1, MAX_PAGE_SIDE / width, MAX_PAGE_SIDE / height);
  const pageWidth = width * scale,
    pageHeight = height * scale;
  const iframe = document.createElement("iframe");
  iframe.title = "PDF древа";
  iframe.name = "drevo-pdf";
  iframe.dataset.treePrint = "";
  iframe.setAttribute("aria-hidden", "true");
  // Keep the print viewport underneath the app so its layout can be measured.
  iframe.style.cssText = `position:fixed;left:0;top:0;width:${width}px;height:${height}px;border:0;pointer-events:none;opacity:0;z-index:-1`;
  document.body.append(iframe);
  const target = iframe.contentDocument!;
  const printWindow = iframe.contentWindow!;
  // about:blank starts in quirks mode, which ignores the intended body/page
  // dimensions when a very wide tree needs physical page scaling.
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
      @page { size: ${pageWidth}px ${pageHeight}px; margin: 0; }
      html, body { margin: 0 !important; padding: 0 !important; width: ${pageWidth}px !important; height: ${pageHeight}px !important; overflow: hidden !important; }
      * { animation: none !important; transition: none !important; print-color-adjust: exact !important; -webkit-print-color-adjust: exact !important; }
      .tree-print-canvas { position: absolute !important; inset: 0 auto auto 0 !important; background: ${tree.white ? "#fff" : "#f8f7f2"}; }
      @media print { .tree-print-canvas { zoom: ${scale}; } }
      .react-flow__handle { visibility: hidden !important; }
      .react-flow__panel, .react-flow__attribution { display: none !important; }
    `;
      target.head.append(styles);
      const ready = new Promise<void>((resolve) => {
        root.render(
          <TreeActions.Provider value={tree.actions}>
            <PrintTree
              {...tree}
              width={width}
              height={height}
              x={padding - left}
              y={padding - top}
              onReady={resolve}
            />
          </TreeActions.Provider>,
        );
      });
      // Timeout also cleans up failed exports; a later resolution cannot print.
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
      // Freeze the measured HTML/SVG before print media changes dimensions.
      // No React Flow listeners or further handle measurements are needed.
      const snapshot = target.body.firstElementChild!.cloneNode(true);
      root.unmount();
      target.body.replaceChildren(snapshot);
      await Promise.all(Array.from(target.images, (image) => image.decode()));
    })();
    await Promise.race([
      prepared,
      cancelled,
      new Promise<never>((_, reject) => {
        expiry = setTimeout(
          () => reject(new Error("Подготовка PDF заняла слишком долго.")),
          30_000,
        );
      }),
    ]);
    clearTimeout(expiry);
    printWindow.addEventListener("afterprint", () => setTimeout(dispose, 0), {
      once: true,
    });
    // Some mobile browsers do not dispatch afterprint.
    expiry = setTimeout(dispose, 300_000);
    printWindow.print();
  } catch (error) {
    dispose();
    throw error;
  }
}
