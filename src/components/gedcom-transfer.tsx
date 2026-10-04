import { archiveFetch } from "../data/archive-fetch.ts";
import { archiveResourceUrl } from "../domain/archive-context.ts";
import { useState } from "react";
import { Download, Upload } from "lucide-react";
import type { Family } from "../domain";
import { JsonArchiveImport } from "./json-archive-import";
import { JsonAdditionsImport } from "./json-additions-import";
import { JsonImportUndo } from "./json-import-undo";
import {
  TRANSFER_PACKAGE_LIMIT,
  TRANSFER_XML_LIMIT,
  type GenealogyExportFormat,
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
export function GedcomTransfer({
  onImported,
  save,
  canEdit,
}: {
  onImported: () => void;
  save: (family: Family) => Promise<Family>;
  canEdit: boolean;
}) {
  const [format, setFormat] = useState<GenealogyExportFormat>("gedzip7");
  const [file, setFile] = useState<File | null>(null),
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
      const xmlFile = /\.xml$/i.test(file.name);
      if (file.size > (xmlFile ? TRANSFER_XML_LIMIT : TRANSFER_PACKAGE_LIMIT))
        throw new Error(
          `Максимальный размер ${xmlFile ? "XML" : "пакета"} — ${xmlFile ? "256" : "512"} МиБ`,
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
  return (
    <section className="gedcom-transfer">
      <h2>Экспорт</h2>
      <p>Обмен данными с генеалогическими программами.</p>
      <fieldset className="genealogy-formats" aria-label="Формат экспорта">
        {(
          [
            ["gedcom551", "GEDCOM 5.5.1", "Максимальная совместимость"],
            ["gedcom7", "GEDCOM 7", "Современный стандарт"],
            ["gedzip7", "GEDZIP 7", "GEDCOM + фотографии + документы"],
          ] as const
        ).map(([value, title, description]) => (
          <label
            key={value}
            htmlFor={`export-${value}`}
            aria-label={title}
            className="genealogy-format"
          >
            <input
              id={`export-${value}`}
              type="radio"
              name="genealogy-export"
              value={value}
              checked={format === value}
              onChange={() => setFormat(value)}
            />
            <span>
              <strong>{title}</strong>
              <small>{description}</small>
            </span>
          </label>
        ))}
      </fieldset>
      <p>
        GEDCOM и GEDZIP сохраняют текст цитат, а GEDZIP также оригиналы файлов.
        Связи цитат с каталогом источников Drevo не переносятся. Для полного
        переноса между древами Drevo используйте формат .drevo.
        Название и описание архива записываются в заголовок GEDCOM; длинные
        значения дополнительно сохраняются в поле Drevo, которое сторонняя
        программа может удалить при повторном экспорте.
      </p>
      <a
        className="primary-action"
        href={archiveResourceUrl(`/api/gedcom/export?format=${format}`)}
        download
      >
        <Download size={16} />
        Скачать выбранный формат
      </a>
      <div className="json-export">
        <a
          href={archiveResourceUrl("/api/export.json?download=1")}
          download="drevo-family.json"
        >
          <Download size={16} /> Экспорт JSON без фото
        </a>
        <p>Карточки и связи для анализа; файлы фотографий не включены.</p>
      </div>
      <hr />
      <h2>Импорт</h2>
      <p>
        GEDCOM 5.5.1 / 7 — до 32 МиБ, GEDZIP — до 512 МиБ, XML с вложениями — до
        256 МиБ; PDF — до 100 МБ, TIFF — до 50 МБ, фото — до 20 МБ. XML с папкой .files упакуйте в
        один ZIP.
      </p>
      <label>
        Файл GEDCOM, GEDZIP или XML «Древа Жизни 6»
        <input
          disabled={busy}
          type="file"
          accept=".ged,.gedcom,.gdz,.gedzip,.zip,.xml"
          onChange={(e) => {
            setFile(e.target.files?.[0] || null);
            setPreview(null);
            setError("");
            setDone("");
          }}
        />
      </label>
      <button
        type="button"
        disabled={!file || busy}
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
            disabled={busy}
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
      <hr />
      <JsonAdditionsImport canEdit={canEdit} onImported={onImported} />
      <JsonImportUndo canEdit={canEdit} onImported={onImported} />
      <details>
        <summary>Полная замена архива из JSON</summary>
        <JsonArchiveImport save={save} canEdit={canEdit} />
      </details>
    </section>
  );
}
