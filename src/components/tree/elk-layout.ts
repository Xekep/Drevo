import ELK from "elkjs/lib/elk-api.js";
import ElkWorker from "elkjs/lib/elk-worker.min.js?worker";
import type { ElkNode } from "elkjs";

/** One ELK worker serves successive layouts until the owning worker is closed. */
export function createUnionLayout() {
  const engine = new ELK({
    algorithms: ["layered"],
    workerFactory: () => new ElkWorker(),
  });
  return {
    layout: (graph: ElkNode) => engine.layout(graph),
    dispose: () => engine.terminateWorker(),
  };
}
