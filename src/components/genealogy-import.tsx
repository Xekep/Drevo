import { archiveFetch } from "../data/archive-fetch.ts";
import { useEffect, useState } from "react";
import { Upload } from "lucide-react";
import {
  TRANSFER_PACKAGE_LIMIT,
  TRANSFER_TEXT_LIMIT,
  TRANSFER_XML_LIMIT,
} from "../domain/genealogy-transfer";
type Preview = {
  token: string;
  version: string;
  photos: number;
  documents: number;
  people: number;
  connections: number;
  events: number;
  warnings: string[];
  warningCount: number;
  possibleDuplicates: string[];
  duplicateCount: number;
  sample: { name: string; birth: string; death?: string }[];
};
export function GenealogyImport({
  canEdit,
  onImported,
  initialFile,
  onBusyChange,
  format,
}: {
  canEdit: boolean;
  onImported: () => void;
  initialFile: File;
  onBusyChange?: (busy: boolean) => void;
  format: "gedcom" | "gedzip" | "xml";
}) {
  const [file, setFile] = useState<File | null>(initialFile || null),
    [preview, setPreview] = useState<Preview | null>(null),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false),
    [done, setDone] = useState("");
  async function inspect() {
    if (!file) return;
    setBusy(true);
    setError("");
    setPreview(null);
    setDone("");
    try {
      const limit =
        format === "gedcom"
          ? TRANSFER_TEXT_LIMIT
          : format === "xml"
            ? TRANSFER_XML_LIMIT
            : TRANSFER_PACKAGE_LIMIT;
      if (file.size > limit)
        throw new Error(
          `Максимальный размер файла — ${limit / 1024 / 1024} МиБ`,
        );
      const r = await archiveFetch("/api/gedcom/preview", {
        method: "POST",
        headers: {
          "X-Drevo-Import": "1",
          "Content-Type": "application/octet-stream",
        },
        body: file,
      });
      const data = await r.json();
      if (!r.ok) throw new Error(data.error);
      setPreview(data);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  async function apply() {
    if (!preview) return;
    setBusy(true);
    setError("");
    try {
      const r = await archiveFetch("/api/gedcom/import", {
        method: "POST",
        headers: { "X-Drevo-Import": "1", "Content-Type": "application/json" },
        body: JSON.stringify({ token: preview.token, confirm: true }),
      });
      const data = await r.json();
      if (!r.ok) throw new Error(data.error);
      setDone(
        `Добавлено людей: ${data.added}; фотографий: ${data.photos || 0}; документов: ${data.documents || 0}.`,
      );
      setPreview(null);
      setFile(null);
      onImported();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  useEffect(() => {
    onBusyChange?.(busy);
  }, [busy, onBusyChange]);
  return (
    <section className="genealogy-import">
      {file && (
        <p role="status">
          {format === "gedcom"
            ? "GEDCOM — до 32 МиБ."
            : format === "gedzip"
              ? "GEDZIP — до 512 МиБ."
              : "XML с вложениями — до 256 МиБ."}
        </p>
      )}
      <details>
        <summary>Ограничения вложений</summary>
        <p>PDF — до 100 МБ, TIFF — до 50 МБ, фото — до 20 МБ.</p>
      </details>
      <button
        type="button"
        disabled={!file || busy || !canEdit}
        onClick={() => void inspect()}
      >
        <Upload size={16} />
        {busy ? "Обрабатываем…" : "Проверить файл"}
      </button>
      {preview && (
        <div className="gedcom-preview">
          <h3>Будет добавлено</h3>
          <p>
            {preview.people} человек · {preview.connections} связей ·{" "}
            {preview.events} событий · {preview.photos} фотографий ·{" "}
            {preview.documents} документов
          </p>
          <p>Формат: {preview.version}</p>
          <p>
            Существующие карточки и фотографии сохранятся. Перед импортом сервер
            сделает резервную копию базы.
          </p>
          {!!preview.warnings.length && (
            <details open>
              <summary>Особенности переноса · {preview.warningCount}</summary>
              <ul>
                {preview.warnings.map((w, i) => (
                  <li key={i}>{w}</li>
                ))}
              </ul>
            </details>
          )}
          {!!preview.duplicateCount && (
            <details open>
              <summary>Возможные дубли · {preview.duplicateCount}</summary>
              <ul>
                {preview.possibleDuplicates.map((name, i) => (
                  <li key={i}>{name}</li>
                ))}
              </ul>
              <p>
                Автоматического объединения нет. Повторный импорт создаст новые
                записи.
              </p>
            </details>
          )}
          <details>
            <summary>Первые {preview.sample.length} карточек</summary>
            <ul>
              {preview.sample.map((p, i) => (
                <li key={i}>
                  {p.name}
                  {p.birth && ` · ${p.birth}`}
                  {p.death && ` — ${p.death}`}
                </li>
              ))}
            </ul>
          </details>
          <button
            type="button"
            className="primary-action"
            disabled={busy || !canEdit}
            onClick={() => void apply()}
          >
            Подтвердить добавление {preview.people} человек
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
