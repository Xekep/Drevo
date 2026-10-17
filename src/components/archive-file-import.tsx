import { useState } from "react";
import type { Family } from "../domain";
import { GenealogyImport } from "./genealogy-import";
import { JsonAdditionsImport } from "./json-additions-import";
import { JsonArchiveImport } from "./json-archive-import";
import { JsonImportUndo } from "./json-import-undo";
import { PortableImport } from "./portable-import";
import {
  detectImportFileFormat,
  IMPORT_FORMAT_NAMES,
  type ImportFileFormat,
} from "./import-file-format";

export function ArchiveFileImport({
  canEdit,
  save,
  onImported,
}: {
  canEdit: boolean;
  save: (family: Family) => Promise<Family>;
  onImported: () => void;
}) {
  const [selected, setSelected] = useState<{
    file: File;
    format: ImportFileFormat;
    key: number;
  } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [version, setVersion] = useState(0);
  return (
    <section className="archive-file-import">
      <p>
        GEDCOM, GEDZIP, XML «Древа Жизни», JSON или .drevo. Формат определится
        автоматически; изменения применятся после проверки и подтверждения.
      </p>
      <label className="json-additions-file">
        Файл для импорта
        <input
          type="file"
          accept=".ged,.gedcom,.gdz,.gedzip,.xml,.zip,.json,.drevo"
          disabled={busy || !canEdit}
          onChange={async (event) => {
            const file = event.target.files?.[0];
            event.target.value = "";
            setSelected(null);
            setError("");
            if (!file) return;
            setBusy(true);
            try {
              const format = await detectImportFileFormat(file);
              setSelected({ file, format, key: version + 1 });
              setVersion(version + 1);
            } catch (reason) {
              setError((reason as Error).message);
            } finally {
              setBusy(false);
            }
          }}
        />
      </label>
      {!canEdit && <p>Импорт доступен при разрешённом редактировании древа.</p>}
      {error && (
        <p className="form-error" role="alert">
          {error}
        </p>
      )}
      {selected && (
        <div key={selected.key} className="archive-import-selected">
          <p className="json-additions-filename">
            {selected.file.name} · {IMPORT_FORMAT_NAMES[selected.format]}
          </p>
          <fieldset disabled={!canEdit}>
            {selected.format === "additions" ? (
              <JsonAdditionsImport
                initialFile={selected.file}
                canEdit={canEdit}
                onImported={onImported}
                onBusyChange={setBusy}
              />
            ) : selected.format === "json" ? (
              <JsonArchiveImport
                initialFile={selected.file}
                canEdit={canEdit}
                save={save}
                onImported={onImported}
                onBusyChange={setBusy}
              />
            ) : selected.format === "drevo" ? (
              <PortableImport
                initialFile={selected.file}
                onImported={onImported}
                onBusyChange={setBusy}
              />
            ) : (
              <GenealogyImport
                initialFile={selected.file}
                format={selected.format}
                canEdit={canEdit}
                onImported={onImported}
                onBusyChange={setBusy}
              />
            )}
          </fieldset>
        </div>
      )}
      <details className="tree-import-history">
        <summary>История и отмена JSON-добавлений</summary>
        <JsonImportUndo canEdit={canEdit} onImported={onImported} />
      </details>
    </section>
  );
}
