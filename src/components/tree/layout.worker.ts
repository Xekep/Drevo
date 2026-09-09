import {
  treeGeometry,
  type TreeMode,
  type LayoutPerson,
} from "../../domain/tree-layout";
import type { FamilyLink } from "../../domain/types";
import { unionGeometry } from "../../domain/union-layout";
import { layoutUnions } from "./elk-layout";
self.onmessage = async (
  event: MessageEvent<{
    people: LayoutPerson[];
    links: Pick<FamilyLink, "type" | "from" | "to">[];
    mode: TreeMode;
    reverse: boolean;
  }>,
) => {
  const { people, links, mode, reverse } = event.data;
  try {
    self.postMessage(
      mode === "generations"
        ? await unionGeometry(people, layoutUnions, reverse, links)
        : treeGeometry(people, mode, reverse, links),
    );
  } catch {
    self.postMessage({
      error:
        "Не удалось рассчитать расположение. Переключите представление, чтобы повторить.",
    });
  }
};
