import { useState } from "react";
import { validateFamily, type Family } from "../domain";

export function JsonArchiveImport({
  save,
  canEdit,
}: {
  save: (family: Family) => Promise<Family>;
  canEdit: boolean;
}) {
  const [imported, setImported] = useState<Family | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [done, setDone] = useState("");

  return (
    <div className="json-archive-import">
      <h3>JSON Drevo</h3>
      <p>
        Заменяет людей и связи текущего архива. Сначала скачайте полную копию:
        файлы фотографий переносятся отдельно.
      </p>
      {!canEdit && <p>Редактирование доступно с компьютера.</p>}
      <label>
        Выберите экспорт архива
        <input
          type="file"
          accept=".json,application/json"
          disabled={busy || !canEdit}
          onChange={async (event) => {
            setError("");
            setDone("");
            setImported(null);
            const file = event.target.files?.[0];
            event.target.value = "";
            if (!file) return;
            try {
              if (file.size > 8 * 1024 * 1024)
                throw new Error("Архив превышает 8 МБ");
              setImported(validateFamily(JSON.parse(await file.text())));
            } catch (reason) {
              setError((reason as Error).message);
            }
          }}
        />
      </label>
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
