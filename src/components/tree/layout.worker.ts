import {
  treeGeometry,
  type TreeMode,
  type LayoutPerson,
} from "../../domain/tree-layout";
import type { FamilyLink } from "../../domain/types";
self.onmessage = (
  event: MessageEvent<{
    people: LayoutPerson[];
    links: Pick<FamilyLink, "type" | "from" | "to">[];
    mode: TreeMode;
    reverse: boolean;
  }>,
) => {
  const { people, links, mode, reverse } = event.data;
  self.postMessage(treeGeometry(people, mode, reverse, links));
};
