import { unionGeometry } from "../../domain/union-layout";
import { unionTimeline } from "../../domain/union-timeline";
import { layoutUnions } from "./elk-layout";
import type { LayoutWorkerRequest } from "./layout-worker-protocol";

self.onmessage = async (event: MessageEvent<LayoutWorkerRequest>) => {
  const { requestId, people, links, mode, reverse } = event.data;
  try {
    const geometry =
      mode === "generations"
        ? await unionGeometry(people, layoutUnions, reverse, links)
        : unionTimeline(
            people,
            await unionGeometry(people, layoutUnions, false, links),
            reverse,
            links,
          );
    // Совместимость с built-worker тестом и старым протоколом оставляем намеренно.
    self.postMessage(
      requestId === undefined ? geometry : { requestId, geometry },
    );
  } catch {
    const error =
      "Не удалось рассчитать расположение. Переключите представление, чтобы повторить.";
    self.postMessage(
      requestId === undefined ? { error } : { requestId, error },
    );
  }
};
