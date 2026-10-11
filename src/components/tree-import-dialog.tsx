import { EditorDialog } from "./editor-dialog";
import { JsonAdditionsImport } from "./json-additions-import";
import { JsonImportUndo } from "./json-import-undo";
import "../styles/tree-import.css";

export function TreeImportDialog({
  canEdit,
  onClose,
  onImported,
}: {
  canEdit: boolean;
  onClose: () => void;
  onImported: () => void;
}) {
  return (
    <EditorDialog
      title="Импорт в древо"
      onClose={onClose}
      className="tree-import-dialog"
    >
      <div className="tree-import-body">
        <JsonAdditionsImport canEdit={canEdit} onImported={onImported} />
        <details className="tree-import-history">
          <summary>История и отмена импорта</summary>
          <JsonImportUndo canEdit={canEdit} onImported={onImported} />
        </details>
      </div>
    </EditorDialog>
  );
}
