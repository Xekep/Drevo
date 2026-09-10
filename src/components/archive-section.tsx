import { lazy, Suspense, type ReactNode } from "react";
import type { ArchiveUser, Family, Person } from "../domain";
import type { ArchiveView } from "../domain/archive-routes";

const PeopleCatalog = lazy(() =>
  import("./people-catalog").then((module) => ({ default: module.PeopleCatalog })),
);
const FamiliesCatalog = lazy(() =>
  import("./families-catalog").then((module) => ({ default: module.FamiliesCatalog })),
);
const Gallery = lazy(() =>
  import("./gallery").then((module) => ({ default: module.Gallery })),
);
const PlacesMap = lazy(() => import("./places-map"));
const InsightsPage = lazy(() => import("./insights-page"));

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
    <Suspense fallback={<div className="archive-status">Открываем раздел…</div>}>
      {content}
    </Suspense>
  );
}
