import { EditorDialog } from "./editor-dialog";
import { ArchiveFileImport } from "./archive-file-import";
import type { Family } from "../domain";
import "../styles/tree-import.css";

export function TreeImportDialog({
  canEdit,
  onClose,
  onImported,
  save,
}: {
  canEdit: boolean;
  onClose: () => void;
  onImported: () => void;
  save: (family: Family) => Promise<Family>;
}) {
  return (
    <EditorDialog
      title="Импорт в древо"
      onClose={onClose}
      className="tree-import-dialog"
    >
      <div className="tree-import-body">
        <ArchiveFileImport canEdit={canEdit} save={save} onImported={onImported} />
      </div>
    </EditorDialog>
  );
}
