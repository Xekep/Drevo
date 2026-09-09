import { type TreeMode, type LayoutPerson } from "../../domain/tree-layout";
import type { FamilyLink } from "../../domain/types";
import { unionGeometry } from "../../domain/union-layout";
import { layoutUnions } from "./elk-layout";
import { unionTimeline } from "../../domain/union-timeline";
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
        : unionTimeline(
            people,
            await unionGeometry(people, layoutUnions, false, links),
            reverse,
            links,
          ),
    );
  } catch {
    self.postMessage({
      error:
        "Не удалось рассчитать расположение. Переключите представление, чтобы повторить.",
    });
  }
};
