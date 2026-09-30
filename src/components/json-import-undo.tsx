import { useState } from "react";
import { archiveFetch } from "../data/archive-fetch.ts";
import type {
  ImportBatch,
  ImportUndoPreview,
} from "../domain/additions-undo.ts";

export function JsonImportUndo({
  canEdit,
  onImported,
}: {
  canEdit: boolean;
  onImported: () => void;
}) {
  const [batches, setBatches] = useState<ImportBatch[] | null>(null);
  const [preview, setPreview] = useState<ImportUndoPreview | null>(null);
  const [busy, setBusy] = useState(false);
  const [confirmed, setConfirmed] = useState(false);
  const [error, setError] = useState("");
  const [done, setDone] = useState("");
  async function request(path: string, data?: unknown) {
    const response = await archiveFetch(
      `/api/import/additions/${path}`,
      data === undefined
        ? { cache: "no-store" }
        : {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(data),
          },
    );
    const value = await response.json();
    if (!response.ok)
      throw new Error(value.error || "Не удалось отменить импорт");
    return value;
  }
  async function inspect(revision?: number) {
    setBusy(true);
    setError("");
    setDone("");
    setPreview(null);
    setConfirmed(false);
    try {
      if (revision === undefined)
        setBatches((await request("history")).batches);
      else
        setPreview(await request("undo-preview", { importRevision: revision }));
    } catch (reason) {
      setError((reason as Error).message);
    } finally {
      setBusy(false);
    }
  }
  async function apply() {
    if (!preview || !confirmed) return;
    setBusy(true);
    setError("");
    try {
      const result = await request("undo", {
        importRevision: preview.importRevision,
        revision: preview.revision,
        fingerprint: preview.fingerprint,
        confirm: true,
      });
      setDone(
        `Импорт отменён. Удалено карточек: ${result.removed}. Остальные карточки сохранены.`,
      );
      setPreview(null);
      setBatches(null);
      setConfirmed(false);
      onImported();
    } catch (reason) {
      setError(
        `${(reason as Error).message}. Обновите историю перед повтором: операция могла сохраниться, если ответ сервера потерялся.`,
      );
      setPreview(null);
      setConfirmed(false);
    } finally {
      setBusy(false);
    }
  }
  return (
    <section aria-label="Отмена импорта">
      <h3>Отменить импорт</h3>
      <p>
        Удалить только карточки выбранного пакета. Остальное древо не
        откатывается. Фотографии и PDF остаются, привязки к удалённым людям
        исчезнут.
      </p>
      <button
        type="button"
        disabled={busy || !canEdit}
        onClick={() => void inspect()}
      >
        Показать импортированные пакеты
      </button>
      {batches && (
        <ul>
          {batches.map((batch) => (
            <li key={batch.revision}>
              {new Date(batch.at).toLocaleString("ru-RU")} · {batch.actorName} ·
              карточек: {batch.count}{" "}
              {batch.undone ? (
                "— отменён"
              ) : (
                <button
                  type="button"
                  disabled={busy || !canEdit}
                  onClick={() => void inspect(batch.revision)}
                >
                  Проверить отмену импорта №{batch.revision}
                </button>
              )}
            </li>
          ))}
        </ul>
      )}
      {batches?.length === 0 && <p>Пакетные импорты не найдены.</p>}
      {preview && (
        <div className="gedcom-preview">
          <p>
            <strong>
              Будет удалено карточек: {preview.people.length} из{" "}
              {preview.importedCount}
            </strong>
          </p>
          <p>
            Уже удалено ранее: {preview.alreadyRemoved}. Связей:{" "}
            {preview.connections}. Отметок на фотографиях: {preview.photoTags}.
          </p>
          {!!preview.editedCount && (
            <p>
              Изменены после импорта: {preview.editedCount}. Эти карточки будут
              удалены вместе с последующими правками.
            </p>
          )}
          {!!preview.errorCount && (
            <div role="alert" className="form-error">
              <strong>Отмена заблокирована</strong>
              <ul>
                {preview.errors.map((text, i) => (
                  <li key={i}>{text}</li>
                ))}
              </ul>
            </div>
          )}
          <details>
            <summary>Карточки к удалению · {preview.people.length}</summary>
            <ul className="json-additions-people">
              {preview.people.map((p) => (
                <li key={p.id}>{p.name}</li>
              ))}
            </ul>
          </details>
          <label>
            <input
              type="checkbox"
              checked={confirmed}
              disabled={busy || !canEdit || !!preview.errorCount}
              onChange={(event) => setConfirmed(event.target.checked)}
            />{" "}
            Удалить перечисленные карточки этого импорта
          </label>
          <button
            type="button"
            className="danger-action"
            disabled={busy || !canEdit || !confirmed || !!preview.errorCount}
            onClick={() => void apply()}
          >
            Отменить импорт и удалить {preview.people.length} карточек
          </button>
        </div>
      )}
      {error && (
        <p role="alert" className="form-error">
          {error}
        </p>
      )}
      {done && <p role="status">{done}</p>}
    </section>
  );
}
