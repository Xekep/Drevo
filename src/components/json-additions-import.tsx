import { useState } from "react";
import { archiveFetch } from "../data/archive-fetch.ts";
import {
  ADDITIONS_MAX_BYTES,
  type AdditionsPreview,
} from "../domain/additions-import.ts";

export function JsonAdditionsImport({
  canEdit,
  onImported,
}: {
  canEdit: boolean;
  onImported: () => void;
}) {
  const [file, setFile] = useState<File | null>(null);
  const [checked, setChecked] = useState<{
    data: unknown;
    preview: AdditionsPreview;
  } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [done, setDone] = useState("");
  async function inspect() {
    if (!file) return;
    setBusy(true);
    setError("");
    setDone("");
    setChecked(null);
    try {
      if (file.size > ADDITIONS_MAX_BYTES - 1000)
        throw new Error("Пакет превышает 8 МБ");
      let data: unknown;
      try {
        data = JSON.parse((await file.text()).replace(/^\uFEFF/, ""));
      } catch {
        throw new Error("Не удалось прочитать JSON. Проверьте файл");
      }
      const response = await archiveFetch("/api/import/additions/preview", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ package: data }),
      });
      const result = await response.json();
      if (!response.ok)
        throw new Error(result.error || "Не удалось проверить пакет");
      setChecked({ data, preview: result });
    } catch (reason) {
      setError((reason as Error).message);
    } finally {
      setBusy(false);
    }
  }
  async function apply() {
    if (!checked) return;
    setBusy(true);
    setError("");
    try {
      const response = await archiveFetch("/api/import/additions/apply", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          package: checked.data,
          revision: checked.preview.revision,
          fingerprint: checked.preview.fingerprint,
          confirm: true,
        }),
      });
      const result = await response.json();
      if (!response.ok)
        throw new Error(result.error || "Не удалось добавить карточки");
      setDone(
        `Добавлено карточек: ${result.added}. Существующие карточки не изменены. Новые отмечены «Требует проверки».`,
      );
      setChecked(null);
      setFile(null);
      onImported();
    } catch (reason) {
      setError(
        `${(reason as Error).message}. Перед повтором проверьте файл: если ответ сервера потерялся, карточки могли сохраниться.`,
      );
      setChecked(null);
    } finally {
      setBusy(false);
    }
  }
  const preview = checked?.preview;
  return (
    <section
      className="json-additions-import"
      aria-labelledby="json-additions-title"
    >
      <h3 id="json-additions-title">Добавить новые карточки из JSON</h3>
      <p>
        Пакет добавлений Drevo · до 1000 человек и 8 МБ. Существующие карточки,
        фотографии и документы сохранятся. Все новые карточки получат отметку
        «Требует проверки».
      </p>
      <label>
        JSON с новыми карточками
        <input
          type="file"
          accept=".json,application/json"
          disabled={busy || !canEdit}
          onChange={(event) => {
            setFile(event.target.files?.[0] || null);
            setChecked(null);
            setError("");
            setDone("");
            event.target.value = "";
          }}
        />
      </label>
      {file && <p>{file.name}</p>}
      <button
        type="button"
        disabled={busy || !file || !canEdit}
        onClick={() => void inspect()}
      >
        {busy ? "Обрабатываем…" : "Проверить пакет JSON"}
      </button>
      {preview && (
        <div className="gedcom-preview">
          <p>
            <strong>
              {preview.people.length} новых карточек · {preview.connections}{" "}
              связей
            </strong>
          </p>
          <p>
            Изменений существующих карточек: 0. Источники, даты и родственные
            связи новых людей будут перенесены из файла.
          </p>
          {!!preview.detachedPeople && (
            <p role="status">
              Без связи с существующим древом: {preview.detachedPeople} новых
              карточек. Они появятся отдельными ветками; родители в существующих
              карточках не дописываются.
            </p>
          )}
          {!!preview.errorCount && (
            <div role="alert" className="form-error">
              <strong>Добавление заблокировано · {preview.errorCount}</strong>
              <ul>
                {preview.errors.map((text, index) => (
                  <li key={index}>{text}</li>
                ))}
              </ul>
            </div>
          )}
          {!!preview.warningCount && (
            <details open>
              <summary>Нужно проверить · {preview.warningCount}</summary>
              <ul>
                {preview.warnings.map((text, index) => (
                  <li key={index}>{text}</li>
                ))}
              </ul>
            </details>
          )}
          <p>
            Проверка выявляет структурные и хронологические ошибки по указанным
            датам. Она не подтверждает родство документами и не обнаружит
            противоречия, отсутствующие в JSON.
          </p>
          <details>
            <summary>Все новые карточки · {preview.people.length}</summary>
            <ul className="json-additions-people">
              {preview.people.map((p) => (
                <li key={p.id}>
                  {p.name}
                  {p.birth ? ` · ${p.birth}` : " · рождение неизвестно"}
                  {p.death ? ` — ${p.death}` : ""}
                </li>
              ))}
            </ul>
          </details>
          <button
            type="button"
            className="primary-action"
            disabled={busy || !canEdit || !!preview.errorCount}
            onClick={() => void apply()}
          >
            Добавить {preview.people.length} карточек
          </button>
        </div>
      )}
      {error && (
        <p className="form-error" role="alert">
          {error}
        </p>
      )}
      {done && <p role="status">{done}</p>}
    </section>
  );
}
