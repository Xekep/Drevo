import { parentPort, workerData } from "node:worker_threads";
import ELK from "elkjs/lib/elk.bundled.js";
import { unionGeometry } from "../domain/union-layout.ts";
import { treeNodeSize } from "../domain/tree-layout-constants.ts";
import type { LayoutCacheInput } from "../domain/layout-cache-key.ts";

const input = workerData as LayoutCacheInput;
const elk = new ELK();
try {
  const geometry = await unionGeometry(
    input.people,
    (graph) => elk.layout(graph),
    input.reverse,
    input.links,
    treeNodeSize(),
  );
  parentPort!.postMessage(geometry);
} finally {
  elk.terminateWorker();
}
