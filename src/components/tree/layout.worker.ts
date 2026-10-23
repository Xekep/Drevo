import { treeNodeSize } from "../../domain/tree-layout-constants";
import { unionGeometry } from "../../domain/union-layout";
import { unionTimeline } from "../../domain/union-timeline";
import { createUnionLayout } from "./elk-layout";
import type { LayoutWorkerRequest } from "./layout-worker-protocol";
import { optimizeDisplayedTree } from "../../domain/optimize-tree-layout";

let engine: ReturnType<typeof createUnionLayout> | undefined;
self.onmessage = async (event: MessageEvent<LayoutWorkerRequest>) => {
  const {
    requestId,
    people,
    links,
    mode,
    reverse,
    previousGeometry,
    parallelCandidates,
    optimizeDisplayed,
  } = event.data;
  try {
    if (optimizeDisplayed) {
      if (!previousGeometry) throw new Error("Нет текущей раскладки");
      const result = optimizeDisplayedTree(previousGeometry, people, links);
      self.postMessage({ requestId, ...result });
      return;
    }
    engine ??= createUnionLayout();
    const geometry =
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
    // Совместимость с built-worker тестом и старым протоколом оставляем намеренно.
    self.postMessage(
      requestId === undefined ? geometry : { requestId, geometry },
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
