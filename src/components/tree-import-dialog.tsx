import { EditorDialog } from "./editor-dialog";
import { JsonAdditionsImport } from "./json-additions-import";

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
    <EditorDialog title="Импорт в древо" onClose={onClose} wide>
      <div className="archive-form">
        <JsonAdditionsImport canEdit={canEdit} onImported={onImported} />
      </div>
    </EditorDialog>
  );
}
