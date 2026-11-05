import { useState } from "react";
import type { TreeGeometry } from "../../domain/tree-layout.ts";
import { translateTreeGeometry, treeLayoutOrigin } from "./tree-layout-origin.ts";

/** Keep projection changes around the same person, including cached layouts.
 * Branch edits keep their existing camera anchor and use the current origin. */
export function useTreeLayoutOrigin(raw: TreeGeometry | null, ready: boolean,
  projection: string, access: string | null, anchorId?: string | null) {
  const [state, setState] = useState({ raw, geometry: raw, projection, access, offset: { x: 0, y: 0 } });
  if (state.access !== access) {
    setState({ raw, geometry: raw, projection, access, offset: { x: 0, y: 0 } });
    return raw;
  }
  if (!ready || !raw) return state.geometry;
  if (state.raw !== raw || state.projection !== projection) {
    const compatible = raw.mode === "generations" && state.geometry?.mode === raw.mode &&
      state.geometry.reverse === raw.reverse;
    const offset = !compatible ? { x: 0, y: 0 } : state.projection !== projection
      ? treeLayoutOrigin(state.geometry!, raw, anchorId) : state.offset;
    const geometry = translateTreeGeometry(raw, offset);
    setState({ raw, geometry, projection, access, offset });
    return geometry;
  }
  return state.geometry;
}
