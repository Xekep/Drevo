import { archiveFetch } from "../data/archive-fetch.ts";
import { archiveResourceUrl } from "../domain/archive-context.ts";
import { useRef, useState } from "react";
import { FileUp, RotateCcw } from "lucide-react";
import type { RestorePreview } from "../shared/backup-management";
export function BackupRestore({
  archiveId,
  onRestored,
  initialPreview,
  onCancel,
}: {
  archiveId: string | null;
  onRestored: () => void;
  initialPreview?: RestorePreview;
  onCancel?: () => void;
}) {
  const input = useRef<HTMLInputElement>(null);
  const [file, setFile] = useState<File | null>(null),
    [preview, setPreview] = useState<RestorePreview | null>(
      initialPreview || null,
    ),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [notice, setNotice] = useState(""),
    [confirmed, setConfirmed] = useState(false),
    [restoreComments, setRestoreComments] = useState(initialPreview?.canRestoreComments || false);
  async function send(apply = false) {
    if (!apply && !file) return;
    setBusy(true);
    setError("");
    setNotice("");
    try {
      if (file && file.size > 12 * 1024 * 1024 * 1024)
        throw new Error("Максимальный размер — 12 ГиБ");
      const response = await archiveFetch(
        archiveResourceUrl(`/api/restore/${apply ? "apply" : "preview"}`,
          archiveId ? `/a/${archiveId}` : "/"),
        {
          method: "POST",
          headers: {
            "Content-Type": apply
              ? "application/json"
              : "application/octet-stream",
            "X-Drevo-Restore": "1",
            ...(!apply && restoreComments ? { "X-Drevo-Restore-Comments": "1" } : {}),
          },
          body: apply
            ? JSON.stringify({ token: preview?.token, confirm: confirmed,
                restoreComments })
            : file,
        },
      );
      const data = await response.json();
      if (!response.ok)
        throw new Error(data.error || "Не удалось восстановить бэкап");
      if (apply) {
        setPreview(null);
        setFile(null);
        if (input.current) input.current.value = "";
        setConfirmed(false);
        setRestoreComments(false);
        setNotice(
          "Древо восстановлено. Предыдущая база сохранена на сервере: " +
            data.backupName,
        );
        onRestored();
      } else {
        setPreview(data);
        setConfirmed(false);
        setRestoreComments(restoreComments && data.canRestoreComments === true);
      }
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="backup-restore">
      <h2>Восстановить из бэкапа</h2>
      {!initialPreview && (
        <>
          <p>
            Выберите базу <b>.sqlite</b> или полный архив <b>.tar.gz</b> с
            фотографиями. До 12 ГиБ.
          </p>
          <label className="restore-file">
            <FileUp size={22} />
            <span>{file?.name || "Выбрать резервную копию"}</span>
            <input
              type="file"
              ref={input}
              accept=".sqlite,.db,.tar.gz,.gz"
              disabled={busy}
              onChange={(e) => {
                setFile(e.target.files?.[0] || null);
                setPreview(null);
                setConfirmed(false);
                setError("");
                setNotice("");
              }}
            />
          </label>
          {!preview && (
            <label className="restore-confirm">
              <input type="checkbox" checked={restoreComments} disabled={busy}
                onChange={(event) => setRestoreComments(event.target.checked)} />
              Подготовить восстановление комментариев и вложений из копии
            </label>
          )}
          <button
            type="button"
            disabled={!file || busy}
            onClick={() => void send()}
          >
            {busy ? "Обрабатываем…" : "Проверить бэкап"}
          </button>
        </>
      )}
      {preview && (
        <div className="restore-preview">
          <h3>{preview.title || "Семейный архив"}</h3>
          <p>
            Людей:{" "}
            <b>
              {preview.currentPeople} → {preview.people}
            </b>
            . Фотографий:{" "}
            <b>
              {preview.currentPhotos} → {preview.photos}
            </b>
            . Файлов снимков в бэкапе: {preview.files}. Документов:{" "}
            {preview.documents || 0}.
          </p>
          {preview.missing > 0 && (
            <p className="restore-warning">
              Для {preview.missing} изображений отсутствуют файлы. Они не
              появятся после импорта базы; загрузите полный бэкап с фото.
            </p>
          )}
          <p>
            Люди, связи и альбомы будут заменены. Аккаунты, роли и настройки
            доступа и ИИ-диалоги этого сайта сохранятся. Перед
            заменой сервер сохранит текущую базу; прежние файлы фото останутся
            для восстановления.
          </p>
          {((preview.currentCommentsLost || 0) > 0 ||
            (preview.backupCommentsSkipped || 0) > 0) && (
            <p className="restore-warning" role="alert">
              На момент проверки будут удалены комментарии к людям,
              которых нет в копии:{" "}
              <b>{preview.currentCommentsLost || 0}</b>. При обычном восстановлении
              будут пропущены комментарии и вложения из копии:{" "}
              <b>{preview.backupCommentsSkipped || 0}</b>.
            </p>
          )}
          {preview.backupCommentsSkipped > 0 && (
            preview.canRestoreComments ? (
              <label className="restore-confirm">
                <input type="checkbox" checked={restoreComments} disabled={busy}
                  onChange={(event) => setRestoreComments(event.target.checked)} />
                Восстановить комментарии и вложения из копии ({preview.backupCommentsSkipped})
              </label>
            ) : <p className="restore-warning" role="alert">
              Восстановление комментариев недоступно: {preview.commentsRestoreReason || "проверьте копию повторно"}
            </p>
          )}
          <label className="restore-confirm">
            <input
              type="checkbox"
              checked={confirmed}
              disabled={busy}
              onChange={(e) => setConfirmed(e.target.checked)}
            />
            Заменить текущие данные содержимым этого бэкапа
          </label>
          <button
            className="primary-action"
            type="button"
            disabled={!confirmed || busy}
            onClick={() => void send(true)}
          >
            <RotateCcw size={16} />
            Восстановить архив
          </button>
          {onCancel && (
            <button type="button" disabled={busy} onClick={onCancel}>
              Отмена
            </button>
          )}
        </div>
      )}
      {error && (
        <p role="alert" className="form-error">
          {error}
        </p>
      )}
      {notice && (
        <p role="status" className="admin-notice">
          {notice}
        </p>
      )}
    </div>
  );
}
