import type { ContextType } from "react";
import { archiveConnections, type Family } from "../../domain";
import { projectTree } from "../../domain/family-neighborhood";
import type { TreeGeometry } from "../../domain/tree-layout";
import { buildTreeNodeModel } from "./tree-node-model";
import { buildTreeEdges } from "./tree-edge-adapter";
import type { TaggedLayoutWorkerResponse } from "./layout-worker-protocol";
import { TreeActions } from "./person-node";
import type { ExportTree } from "./tree-pdf";

async function exportGeometry(
  family: Family,
  visible: ReadonlySet<string>,
  reverse: boolean,
  signal?: AbortSignal,
): Promise<TreeGeometry> {
  const worker = new Worker(new URL("./layout.worker.ts", import.meta.url), {
    type: "module",
  });
  return await new Promise<TreeGeometry>((resolve, reject) => {
    const finish = (result: TreeGeometry | Error) => {
      worker.terminate();
      clearTimeout(timeout);
      signal?.removeEventListener("abort", abort);
      if (result instanceof Error) reject(result);
      else resolve(result);
    };
    const abort = () =>
      finish(new DOMException("Экспорт отменён", "AbortError"));
    const timeout = setTimeout(
      () => finish(new Error("Расчёт области экспорта занял слишком долго.")),
      30_000,
    );
    worker.onmessage = (event: MessageEvent<TaggedLayoutWorkerResponse>) => {
      if ("error" in event.data) finish(new Error(event.data.error));
      else finish(event.data.geometry);
    };
    worker.onerror = () =>
      finish(new Error("Не удалось построить область экспорта."));
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) return abort();
    worker.postMessage({
      requestId: 1,
      ...projectTree(family, visible),
      mode: "generations",
      reverse,
    });
  });
}

/** A separate layout keeps the on-screen tree, collapse state and camera intact. */
export async function prepareTreeExport(
  family: Family,
  visible: ReadonlySet<string>,
  reverse: boolean,
  white: boolean,
  actions: ContextType<typeof TreeActions>,
  signal?: AbortSignal,
  extraVisible = false,
): Promise<ExportTree> {
  if (!visible.size) throw new Error("В выбранной области нет людей.");
  const geometry = await exportGeometry(family, visible, reverse, signal);
  signal?.throwIfAborted();
  const growthDelays = new Map<string, number>();
  const model = buildTreeNodeModel({
    family,
    geometry,
    mode: "generations",
    visible,
    selected: [],
    collapsed: new Set(),
    root: null,
    hidden: new Map(),
    expanded: new Set(),
    query: "",
    growthDelays,
  });
  const edges = buildTreeEdges({
    family,
    user: null,
    mode: "generations",
    geometry,
    connections: archiveConnections(family),
    visible,
    positions: model.positions,
    occurrencePeople: model.occurrencePeople,
    peopleMap: model.peopleMap,
    highlighted: [],
    canEdit: false,
    busy: false,
    extraVisible,
    preview: null,
    onEdge: () => {},
    onChoices: () => {},
    growthDelays,
  });
  return {
    nodes: model.displayNodes,
    edges,
    actions,
    title: family.title,
    white,
  };
}
