import { useEffect, useLayoutEffect, useRef } from "react";
import { useStoreApi } from "@xyflow/react";
import type { Person } from "../../domain";
import type { PersonNodeType } from "./person-node";
import type { RelationshipEdgeType } from "./relationship-edge";
import type { HouseholdNodeType } from "./household-node";
import type { createGpuScene } from "./gpu-scene";
import type { GpuPortraitCache } from "./gpu-portrait-cache";

export function TreeGpuScene({
  nodes,
  edges,
  households,
  width,
  height,
  hovered,
  focused,
  relationLabel,
  onReady,
  onFailure,
}: {
  nodes: readonly PersonNodeType[];
  edges: readonly RelationshipEdgeType[];
  households: readonly HouseholdNodeType[];
  width: number;
  height: number;
  hovered: string;
  focused: string;
  relationLabel: (person: Person) => string;
  onReady: () => void;
  onFailure: (reason: string) => void;
}) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const store = useStoreApi();
  const scene = useRef<ReturnType<typeof createGpuScene> | null>(null);
  const portraits = useRef<GpuPortraitCache | undefined>(undefined);
  const state = useRef({ width, height, hovered, focused });
  const schedule = useRef(() => {});
  useLayoutEffect(() => {
    state.current = { width, height, hovered, focused };
  }, [width, height, hovered, focused]);
  useEffect(() => {
    const element = canvas.current!;
    let active = true,
      frame = 0,
      ready = false;
    const failed = (error?: unknown) => {
      if (active)
        onFailure(
          error instanceof Error
            ? error.message
            : "GPU context or drawing failed",
        );
    };
    const draw = () => {
      frame = 0;
      if (!active || !scene.current) return;
      try {
        const current = state.current;
        const [x, y, zoom] = store.getState().transform;
        scene.current.interaction(current.hovered, current.focused);
        scene.current.draw({ x, y, zoom }, current.width, current.height);
        if (!ready && current.width > 0 && current.height > 0) {
          ready = true;
          onReady();
        }
      } catch (error) {
        failed(error);
      }
    };
    const requestDraw = () => {
      if (active && !frame) frame = requestAnimationFrame(draw);
    };
    schedule.current = requestDraw;
    const lost = (event: Event) => {
      event.preventDefault();
      failed();
    };
    element.addEventListener("webglcontextlost", lost);
    const unsubscribe = store.subscribe((next, previous) => {
      if (next.transform !== previous.transform) requestDraw();
    });
    void import("./gpu-scene")
      .then(({ createGpuScene }) => {
        if (!active) return;
        scene.current = createGpuScene(
          element,
          nodes,
          edges,
          households,
          (node) => relationLabel(node.data.person),
          requestDraw,
          failed,
          portraits.current,
        );
        portraits.current = scene.current.portraits;
        requestDraw();
      })
      .catch(failed);
    return () => {
      active = false;
      cancelAnimationFrame(frame);
      unsubscribe();
      element.removeEventListener("webglcontextlost", lost);
      scene.current?.destroy(true);
      scene.current = null;
      schedule.current = () => {};
    };
  }, [nodes, edges, households, relationLabel, store, onReady, onFailure]);
  useEffect(
    () => () => {
      portraits.current?.destroy();
      portraits.current = undefined;
    },
    [],
  );
  useEffect(() => {
    schedule.current();
  }, [width, height, hovered, focused]);
  return <canvas ref={canvas} className="tree-gpu-scene" aria-hidden="true" />;
}
