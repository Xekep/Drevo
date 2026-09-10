import { useState } from "react";
import { Download, Upload } from "lucide-react";
type Preview = {
  token: string;
  people: number;
  connections: number;
  events: number;
  warnings: string[];
  warningCount: number;
  possibleDuplicates: string[];
  duplicateCount: number;
  sample: { name: string; birth: string; death?: string }[];
};
export function GedcomTransfer({ onImported }: { onImported: () => void }) {
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
      if (file.size > 8 * 1024 * 1024)
        throw new Error("Максимальный размер — 8 МБ");
      const r = await fetch("/api/gedcom/preview", {
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
      const r = await fetch("/api/gedcom/import", {
        method: "POST",
        headers: { "X-Drevo-Import": "1", "Content-Type": "application/json" },
        body: JSON.stringify({ token: preview.token, confirm: true }),
      });
      const data = await r.json();
      if (!r.ok) throw new Error(data.error);
      setDone(`Добавлено людей: ${data.added}`);
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
      <h2>Перенос GEDCOM</h2>
      <p>
        Для обмена с генеалогическими программами. Фотографии сохраняйте
        отдельно в полном бэкапе.
      </p>
      <a className="primary-action" href="/api/gedcom/export" download>
        <Download size={16} />
        Скачать GEDCOM
      </a>
      <label>
        Импорт .ged · UTF-8 · до 8 МБ
        <input
          disabled={busy}
          type="file"
          accept=".ged,.gedcom,text/plain"
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
            {preview.events} событий
          </p>
          <p>
            Существующие карточки и фотографии сохранятся. Перед импортом сервер
            сделает резервную копию базы.
          </p>
          {!!preview.warnings.length && (
            <details open>
              <summary>Особенности переноса · {preview.warningCount}</summary>
              <ul>
                {preview.warnings.map((w) => (
                  <li key={w}>{w}</li>
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
    </section>
  );
}
