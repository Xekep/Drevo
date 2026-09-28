import { treeNodeSize } from "../../domain/tree-layout-constants";
import { unionGeometry } from "../../domain/union-layout";
import { unionTimeline } from "../../domain/union-timeline";
import { createUnionLayout } from "./elk-layout";
import type { LayoutWorkerRequest } from "./layout-worker-protocol";

let engine: ReturnType<typeof createUnionLayout> | undefined;
self.onmessage = async (event: MessageEvent<LayoutWorkerRequest>) => {
  const { requestId, people, links, mode, reverse, cardVariant } = event.data;
  try {
    engine ??= createUnionLayout();
    const geometry =
      mode === "generations"
        ? await unionGeometry(
            people,
            engine.layout,
            reverse,
            links,
            treeNodeSize(cardVariant),
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
  } catch {
    engine?.dispose();
    engine = undefined;
    const error =
      "Не удалось рассчитать расположение. Переключите представление, чтобы повторить.";
    self.postMessage(
      requestId === undefined ? { error } : { requestId, error },
    );
  }
};
