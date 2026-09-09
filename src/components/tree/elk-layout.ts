import ELK from "elkjs/lib/elk-api.js";
import ElkWorker from "elkjs/lib/elk-worker.min.js?worker";
import type { ElkNode } from "elkjs";

/** Нативный Worker: bundled-версия ELK внутри Worker перехватывает self.onmessage. */
export async function layoutUnions(graph: ElkNode) {
  const engine = new ELK({
    algorithms: ["layered"],
    workerFactory: () => new ElkWorker(),
  });
  try {
    return await engine.layout(graph);
  } finally {
    engine.terminateWorker();
  }
}
