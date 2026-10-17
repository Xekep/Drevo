import { useLayoutEffect, useRef, useState } from "react";
import {
  depthCamera,
  interpolateDepthCamera,
  type DepthWorld,
} from "../../domain/tree-depth-scene";

/** This camera owns the whole spatial scene; React Flow owns only pan and zoom. */
export function useDepthCamera(
  world: DepthWorld,
  anchorId: string,
  ready: boolean,
) {
  const [offset, setOffset] = useState(0);
  const [frame, setFrame] = useState(() => ({
    camera: depthCamera(world, anchorId),
    moving: false,
  }));
  const current = useRef(frame.camera);
  const previous = useRef({ world, anchorId, offset });
  useLayoutEffect(() => {
    if (!ready) return;
    const target = depthCamera(
      world,
      anchorId,
      previous.current.anchorId === anchorId ? offset : 0,
    );
    const changedWorld = previous.current.world !== world;
    const changedAnchor = previous.current.anchorId !== anchorId;
    previous.current = { world, anchorId, offset };
    if (changedAnchor && offset) setOffset(0);
    const start = current.current,
      began = performance.now();
    const sameCamera =
      Math.hypot(
        start.target.x - target.target.x,
        start.target.y - target.target.y,
        start.target.z - target.target.z,
        start.origin.x - target.origin.x,
        start.origin.y - target.origin.y,
        start.yaw - target.yaw,
      ) < 0.001;
    const duration =
      changedWorld ||
      sameCamera ||
      matchMedia("(prefers-reduced-motion: reduce)").matches
        ? 0
        : 620;
    let raf = 0;
    const step = (now: number) => {
      const t = duration ? Math.min(1, (now - began) / duration) : 1;
      current.current = interpolateDepthCamera(start, target, 1 - (1 - t) ** 3);
      setFrame({ camera: current.current, moving: t < 1 });
      if (t < 1) raf = requestAnimationFrame(step);
    };
    raf = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf);
  }, [world, anchorId, offset, ready]);
  return {
    ...frame,
    offset,
    turn: (delta: number | null) =>
      setOffset((value) =>
        delta === null ? 0 : Math.max(-36, Math.min(36, value + delta)),
      ),
  };
}
