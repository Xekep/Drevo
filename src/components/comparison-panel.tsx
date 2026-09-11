import { lazy, Suspense } from "react";
import type { FamilyLink, Person, Relation } from "../domain";
import { LazyChunkBoundary } from "./lazy-chunk-boundary";
import { loadLazyModule } from "./lazy-section-recovery";

type Props = {
  selected: Person[];
  relation: Relation | null;
  people: Person[];
  links?: FamilyLink[];
  onRemove: (id: string) => void;
  onReveal: () => void;
};

const ComparisonPanelContent = lazy(() =>
  loadLazyModule(
    () =>
      import("./comparison-panel-content").then((module) => ({
        default: module.ComparisonPanel,
      })),
    "comparison-panel",
  ),
);

export function ComparisonPanel(props: Props) {
  return (
    <LazyChunkBoundary message="Сравнение родства не загрузилось. Обновите страницу и повторите открытие.">
      <Suspense
        fallback={
          <div className="archive-status" role="status">
            Считаем родство…
          </div>
        }
      >
        <ComparisonPanelContent {...props} />
      </Suspense>
    </LazyChunkBoundary>
  );
}
