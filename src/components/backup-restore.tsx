import { useRef, useState } from "react";
import { FileUp, RotateCcw } from "lucide-react";
type Preview = {
  token: string;
  title: string;
  people: number;
  photos: number;
  files: number;
  missing: number;
  currentPeople: number;
  currentPhotos: number;
};
export function BackupRestore({ onRestored }: { onRestored: () => void }) {
  const input = useRef<HTMLInputElement>(null);
  const [file, setFile] = useState<File | null>(null),
    [preview, setPreview] = useState<Preview | null>(null),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [notice, setNotice] = useState(""),
    [confirmed, setConfirmed] = useState(false);
  async function send(apply = false) {
    if (!apply && !file) return;
    setBusy(true);
    setError("");
    setNotice("");
    try {
      if (file && file.size > 128 * 1024 * 1024)
        throw new Error("Максимальный размер — 128 МБ");
      const response = await fetch(
        `/api/restore/${apply ? "apply" : "preview"}`,
        {
          method: "POST",
          headers: {
            "Content-Type": apply
              ? "application/json"
              : "application/octet-stream",
            "X-Drevo-Restore": "1",
          },
          body: apply
            ? JSON.stringify({ token: preview?.token, confirm: confirmed })
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
        setNotice(
          "Древо восстановлено. Предыдущая база сохранена на сервере: " +
            data.backupName,
        );
        onRestored();
      } else {
        setPreview(data);
        setConfirmed(false);
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
      <p>
        Выберите базу <b>.sqlite</b> или полный архив <b>.tar.gz</b> с
        фотографиями. До 128 МБ.
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
      <button
        type="button"
        disabled={!file || busy}
        onClick={() => void send()}
      >
        {busy ? "Обрабатываем…" : "Проверить бэкап"}
      </button>
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
            . Файлов снимков в бэкапе: {preview.files}.
          </p>
          {preview.missing > 0 && (
            <p className="restore-warning">
              Для {preview.missing} изображений отсутствуют файлы. Они не
              появятся после импорта базы; загрузите полный бэкап с фото.
            </p>
          )}
          <p>
            Люди, связи и альбомы будут заменены. Аккаунты, роли и настройки
            доступа этого сайта сохранятся. Перед заменой сервер сохранит
            текущую базу; прежние файлы фото останутся для восстановления.
          </p>
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
