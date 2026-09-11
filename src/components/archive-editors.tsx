import { lazy, Suspense } from "react";
import type {
  ArchiveUser,
  ConnectionType,
  Family,
  Person,
} from "../domain";

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
  busy: boolean;
  inline?: boolean;
  suspended?: boolean;
  initialRelationship?: "child" | ConnectionType;
};

const PersonEditorContent = lazy(() =>
  import("./archive-editors-content").then((module) => ({
    default: module.PersonEditor,
  })),
);

export function PersonEditor(props: PersonEditorProps) {
  return (
    <Suspense
      fallback={
        <div className="archive-status" role="status">
          Открываем редактор…
        </div>
      }
    >
      <PersonEditorContent {...props} />
    </Suspense>
  );
}
