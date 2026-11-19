import { treeNodeSize, TREE_NODE_HEIGHT, TREE_NODE_WIDTH } from "../../domain/tree-layout-constants";
import { unionGeometry } from "../../domain/union-layout";
import { unionTimeline } from "../../domain/union-timeline";
import { createUnionLayout } from "./elk-layout";
import type { LayoutWorkerRequest } from "./layout-worker-protocol";
import { optimizeDisplayedTree } from "../../domain/optimize-tree-layout";
import { localTreeLayout } from "../../domain/local-tree-layout";
import { spaceFamilyRoutes } from "../../domain/family-route-spacing";

let engine: ReturnType<typeof createUnionLayout> | undefined;
self.onmessage = async (event: MessageEvent<LayoutWorkerRequest>) => {
  const {
    requestId,
    people,
    links,
    mode,
    reverse,
    previousGeometry,
    previousInput,
    parallelCandidates,
    optimizeDisplayed,
    layoutGoal,
  } = event.data;
  try {
    if (optimizeDisplayed) {
      if (!previousGeometry) throw new Error("Нет текущей раскладки");
      const result = optimizeDisplayedTree(previousGeometry, people, links, layoutGoal);
      self.postMessage({ requestId, ...result });
      return;
    }
    if (mode === "generations" && previousGeometry?.mode === mode && previousGeometry.reverse === reverse && previousInput) {
      const local = localTreeLayout({ people, links }, previousInput, previousGeometry, treeNodeSize());
      if (local) {
        const geometry = local.kind === "local" ? spaceFamilyRoutes(local.geometry) : local.geometry;
        self.postMessage({ requestId, geometry, updateKind: local.kind });
        return;
      }
    }
    engine ??= createUnionLayout();
    const layout =
      mode === "generations"
        ? await unionGeometry(
            people,
            engine.layout,
            reverse,
            links,
            treeNodeSize(),
            previousGeometry,
            true,
            parallelCandidates ? 2 : 1,
          )
        : unionTimeline(
            people,
            await unionGeometry(people, engine.layout, false, links),
            reverse,
            links,
          );
    const geometry = spaceFamilyRoutes(layout, layout.nodeSize || { width: TREE_NODE_WIDTH, height: TREE_NODE_HEIGHT });
    // Совместимость с built-worker тестом и старым протоколом оставляем намеренно.
    self.postMessage(
      requestId === undefined ? geometry : { requestId, geometry, updateKind: "full" },
    );
  } catch (reason) {
    engine?.dispose();
    engine = undefined;
    const error = optimizeDisplayed && reason instanceof Error ? reason.message :
      "Не удалось рассчитать расположение. Переключите представление, чтобы повторить.";
    self.postMessage(
      requestId === undefined ? { error } : { requestId, error },
    );
  }
};
