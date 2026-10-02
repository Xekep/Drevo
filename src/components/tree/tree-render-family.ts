import { archiveOverview } from "../../domain/archive-projection.ts";
import type { Family } from "../../domain/types.ts";

/** Stable render snapshot across card detail hydration and gallery changes. */
export function treeRenderFamilyKey(family: Family): string {
  return JSON.stringify(archiveOverview(family));
}
