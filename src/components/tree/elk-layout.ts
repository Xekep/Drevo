import ELK from "elkjs/lib/elk-api.js";
import ElkWorker from "elkjs/lib/elk-worker.min.js?worker";
import type { ElkNode } from "elkjs";

/** Reuse one engine; create a second only for bounded concurrent candidates. */
export function createUnionLayout() {
  const engines: InstanceType<typeof ELK>[] = [];
  const active = new Set<InstanceType<typeof ELK>>();
  return {
    layout: async (graph: ElkNode) => {
      let engine = engines.find((item) => !active.has(item));
      if (!engine) {
        if (engines.length >= 2) throw new Error("ELK concurrency exceeded");
        engine = new ELK({
          algorithms: ["layered"],
          workerFactory: () => new ElkWorker(),
        });
        engines.push(engine);
      }
      active.add(engine);
      try {
        return await engine.layout(graph);
      } finally {
        active.delete(engine);
      }
    },
    dispose: () => {
      engines.forEach((engine) => engine.terminateWorker());
      engines.length = 0;
      active.clear();
    },
  };
}
