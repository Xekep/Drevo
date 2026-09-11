import { lazy, Suspense } from "react";
import type { ArchiveUser, ConnectionType, Family, Person } from "../domain";
import { LazyChunkBoundary } from "./lazy-chunk-boundary";
import { loadLazyModule } from "./lazy-section-recovery";

type Save = (data: Family) => Promise<Family>;

type PersonEditorProps = {
  family: Family;
  person?: Person;
  isAdmin: boolean;
  user: ArchiveUser | null;
  relativeTo?: Person;
  uploadPortrait: (file: File) => Promise<string>;
  save: Save;
  onClose: () => void;
  onSaved: (id: string) => void;
  onDirtyChange?: (dirty: boolean) => void;
  busy: boolean;
  inline?: boolean;
  suspended?: boolean;
  initialRelationship?: "child" | ConnectionType;
};

const PersonEditorContent = lazy(() =>
  loadLazyModule(
    () =>
      import("./archive-editors-content").then((module) => ({
        default: module.PersonEditor,
      })),
    "person-editor",
  ),
);

export function PersonEditor(props: PersonEditorProps) {
  return (
    <LazyChunkBoundary message="Редактор не загрузился. Обновите страницу, изменения в открытой карточке не отправлялись.">
      <Suspense
        fallback={
          <div className="archive-status" role="status">
            Открываем редактор…
          </div>
        }
      >
        <PersonEditorContent {...props} />
      </Suspense>
    </LazyChunkBoundary>
  );
}
