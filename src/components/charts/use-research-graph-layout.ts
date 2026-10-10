import { useEffect, useState } from "react";
import type { ElkNode } from "elkjs";
import { researchGraphLayoutInput } from "../../domain/research-graph-layout.ts";
import type { ResearchGraph } from "../../domain/research-visual.ts";
import { createUnionLayout } from "../tree/elk-layout.ts";

/** Owns a cancellable-by-disposal ELK worker, independent of tree camera/rendering. */
export function useResearchGraphLayout(graph: ResearchGraph | undefined) {
  const [result, setResult] = useState<{
    graph: ResearchGraph;
    layout?: ElkNode;
    error?: string;
  }>();
  useEffect(() => {
    if (!graph) return;
    const engine = createUnionLayout();
    let active = true;
    void engine.layout(researchGraphLayoutInput(graph)).then(
      (layout) => {
        if (active) setResult({ graph, layout });
      },
      () => {
        if (active) setResult({ graph, error: "Не удалось расположить схему" });
      },
    );
    return () => {
      active = false;
      engine.dispose();
    };
  }, [graph]);
  return result?.graph === graph ? result : undefined;
}
