import { useState } from "react";
import type { TreeGeometry } from "../../domain/tree-layout.ts";
import { translateTreeGeometry, treeLayoutOrigin } from "./tree-layout-origin.ts";

type NavigationAnchor = { personId: string; occurrenceId: string | null; position: { x: number; y: number }; token: number };

/** Keep projection changes around the same person, including cached layouts.
 * Branch edits keep their existing camera anchor and use the current origin. */
export function useTreeLayoutOrigin(raw: TreeGeometry | null, ready: boolean,
  projection: string, access: string | null, anchorId?: string | null, navigation?: NavigationAnchor | null) {
  const [state, setState] = useState({ raw, geometry: raw, projection, access, offset: { x: 0, y: 0 }, anchorToken: 0 });
  if (state.access !== access) {
    setState({ raw, geometry: raw, projection, access, offset: { x: 0, y: 0 }, anchorToken: navigation?.token || 0 });
    return raw;
  }
  if (!ready || !raw) return state.geometry;
  if (state.raw !== raw || state.projection !== projection) {
    const compatible = raw.mode === "generations" && state.geometry?.mode === raw.mode &&
      state.geometry.reverse === raw.reverse;
    const requested = compatible && navigation && navigation.token !== state.anchorToken ? navigation : null;
    const occurrence = requested && (raw.occurrences?.find(o => o.personId === requested.personId)?.id || requested.personId);
    const nextPositions = new Map(raw.positions);
    const target = requested && (nextPositions.get(requested.occurrenceId || "") ||
      nextPositions.get(requested.personId) || nextPositions.get(occurrence || ""));
    const offset = target && requested ? { x: requested.position.x - target.x, y: requested.position.y - target.y }
      : !compatible ? { x: 0, y: 0 } : state.projection !== projection
      ? treeLayoutOrigin(state.geometry!, raw, anchorId) : state.offset;
    const geometry = translateTreeGeometry(raw, offset);
    setState({ raw, geometry, projection, access, offset, anchorToken: requested?.token || state.anchorToken });
    return geometry;
  }
  return state.geometry;
}
