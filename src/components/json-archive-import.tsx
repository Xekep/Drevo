import { useEffect, useState } from "react";
import { validateFamily, type Family } from "../domain";

export function JsonArchiveImport({
  save,
  canEdit,
  initialFile,
  onBusyChange,
  onImported,
}: {
  save: (family: Family) => Promise<Family>;
  canEdit: boolean;
  initialFile: File;
  onBusyChange?: (busy: boolean) => void;
  onImported?: () => void;
}) {
  const [imported, setImported] = useState<Family | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [done, setDone] = useState("");
  useEffect(() => { onBusyChange?.(busy); }, [busy, onBusyChange]);
  useEffect(() => {
    if (!initialFile) return;
    let active = true;
    void (async () => {
      try {
        if (initialFile.size > 8 * 1024 * 1024) throw new Error("Архив превышает 8 МБ");
        const family = validateFamily(JSON.parse((await initialFile.text()).replace(/^\uFEFF/, "")));
        if (active) setImported(family);
      } catch (reason) {
        if (active) setError((reason as Error).message);
      }
    })();
    return () => { active = false; };
  }, [initialFile]);

  return (
    <div className="json-archive-import">
      <h3>JSON Drevo</h3>
      <p>
        Заменяет людей и связи текущего архива. Сначала скачайте полную копию:
        файлы фотографий переносятся отдельно.
      </p>
      {!canEdit && <p>Для импорта нужен доступ к редактированию.</p>}
      {imported && (
        <div className="gedcom-preview">
          <p>
            «{imported.title}»: {imported.people.length} человек,{" "}
            {imported.photos?.length || 0} фотографий.
          </p>
          <button
            type="button"
            disabled={busy || !canEdit}
            onClick={async () => {
              setBusy(true);
              setError("");
              try {
                await save(imported);
                setImported(null);
                setDone("Данные архива заменены.");
                onImported?.();
              } catch (reason) {
                setError((reason as Error).message);
              } finally {
                setBusy(false);
              }
            }}
          >
            {busy ? "Импортируем…" : "Заменить архив этими данными"}
          </button>
        </div>
      )}
      {error && (
        <p className="form-error" role="alert">
          {error}
        </p>
      )}
      {done && <p role="status">{done}</p>}
    </div>
  );
}
