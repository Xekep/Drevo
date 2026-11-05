import type { LayoutPerson, TreeMode } from "./tree-layout.ts";
import type { FamilyLink } from "./types.ts";
import { treeNodeSize } from "./tree-layout-constants.ts";

export const LAYOUT_CACHE_VERSION = 32;
export const SHARED_LAYOUT_MAX_PEOPLE = 1000;
export type LayoutCacheInput = {
  people: LayoutPerson[];
  links: Pick<FamilyLink, "type" | "from" | "to">[];
  mode: TreeMode;
  reverse: boolean;
};

// Model order affects ELK; do not sort people or include text/portrait revisions.
export function layoutCacheKey(input: LayoutCacheInput) {
  return JSON.stringify({
    version: LAYOUT_CACHE_VERSION,
    ...treeNodeSize(),
    input: {
      people: input.people,
      links: input.links,
      mode: input.mode,
      reverse: input.reverse,
    },
  });
}
