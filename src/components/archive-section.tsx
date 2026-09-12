import { Component, lazy, Suspense, type ReactNode } from "react";
import type { ArchiveUser, Family, Person } from "../domain";
import type { ArchiveView } from "../domain/archive-routes";
import { ArchiveLoading } from "./archive-loading";
import { loadLazyModule } from "./lazy-section-recovery";

const PeopleCatalog = lazy(() =>
  loadLazyModule(async () => {
    const module = await import("./people-catalog");
    return { default: module.PeopleCatalog };
  }, "people"),
);
const FamiliesCatalog = lazy(() =>
  loadLazyModule(async () => {
    const module = await import("./families-catalog");
    return { default: module.FamiliesCatalog };
  }, "families"),
);
const Gallery = lazy(() =>
  loadLazyModule(async () => {
    const module = await import("./gallery");
    return { default: module.Gallery };
  }, "gallery"),
);
const PlacesMap = lazy(() =>
  loadLazyModule(() => import("./places-map"), "places"),
);
const InsightsPage = lazy(() =>
  loadLazyModule(() => import("./insights-page"), "insights"),
);

type Props = {
  view: ArchiveView;
  family: Family;
  people: Person[];
  query: string;
  user: ArchiveUser | null;
  canEdit: boolean;
  busy: boolean;
  loadingDetails: boolean;
  save: (family: Family) => Promise<Family>;
  onPerson: (id: string) => void;
  onReveal: (ids: string[]) => void;
  onPhoto: (id: string, photoIds?: string[]) => void;
  onAddPhoto: () => void;
  onDropPhoto: (file: File) => void;
  personFilter: string | null;
  onClearPhotoFilter: () => void;
};

type BoundaryProps = { children: ReactNode };
type BoundaryState = { failed: boolean };

class SectionErrorBoundary extends Component<BoundaryProps, BoundaryState> {
  state: BoundaryState = { failed: false };

  static getDerivedStateFromError(): BoundaryState {
    return { failed: true };
  }

  componentDidCatch(error: unknown) {
    console.error("Не удалось открыть раздел архива", error);
  }

  render() {
    if (this.state.failed)
      return (
        <div className="archive-status" role="alert">
          <h1>Раздел не открылся</h1>
          <p>
            Приложение могло обновиться или файл раздела не загрузился. Обновите
            страницу и повторите переход.
          </p>
          <button
            className="primary-action"
            type="button"
            onClick={() => window.location.reload()}
          >
            Обновить страницу
          </button>
        </div>
      );
    return this.props.children;
  }
}

export function ArchiveSection(props: Props) {
  let content: ReactNode = null;
  if (props.view === "list")
    content = (
      <PeopleCatalog
        people={props.people}
        query={props.query}
        onSelect={props.onPerson}
      />
    );
  else if (props.view === "places")
    content = (
      <PlacesMap
        family={props.family}
        user={props.user}
        canEdit={props.canEdit}
        busy={props.busy}
        save={props.save}
        onPerson={props.onPerson}
        onPhoto={props.onPhoto}
      />
    );
  else if (props.view === "families")
    content = (
      <FamiliesCatalog
        people={props.people}
        onPerson={props.onPerson}
        onReveal={props.onReveal}
      />
    );
  else if (props.view === "gallery")
    content = (
      <Gallery
        family={props.family}
        canEdit={props.canEdit}
        onAdd={props.onAddPhoto}
        onDropPhoto={props.onDropPhoto}
        onOpen={props.onPhoto}
        personFilter={props.personFilter}
        onClearFilter={props.onClearPhotoFilter}
      />
    );
  else if (props.view === "insights")
    content = (
      <InsightsPage
        family={props.family}
        loadingDetails={props.loadingDetails}
        onPerson={props.onPerson}
      />
    );

  if (!content) return null;
  return (
    <SectionErrorBoundary key={props.view}>
      <Suspense fallback={<ArchiveLoading />}>{content}</Suspense>
    </SectionErrorBoundary>
  );
}
