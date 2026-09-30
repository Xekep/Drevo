import { useState } from "react";
import { archiveFetch } from "../data/archive-fetch.ts";
import { scopedArchivePath } from "../domain/archive-context.ts";

type Preview = {
  token: string;
  title: string;
  people: number;
  photos: number;
  documents: number;
  comments: number;
  bytes: number;
};

export function PortableImport() {
  const [file, setFile] = useState<File | null>(null);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  async function inspect() {
    if (!file) return;
    setBusy(true);
    setError("");
    setPreview(null);
    try {
      const response = await archiveFetch("/api/drevo/preview", {
        method: "POST",
        headers: {
          "X-Drevo-Import": "1",
          "Content-Type": "application/octet-stream",
        },
        body: file,
      });
      const data = await response.json();
      if (!response.ok)
        throw new Error(data.error || "Не удалось проверить архив");
      setPreview(data as Preview);
    } catch (cause) {
      setError((cause as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function apply() {
    if (!preview) return;
    setBusy(true);
    setError("");
    try {
      const response = await archiveFetch("/api/drevo/import", {
        method: "POST",
        headers: { "X-Drevo-Import": "1", "Content-Type": "application/json" },
        body: JSON.stringify({ token: preview.token, confirm: true }),
      });
      const data = await response.json();
      if (!response.ok)
        throw new Error(data.error || "Не удалось импортировать архив");
      window.location.assign(scopedArchivePath("/tree"));
    } catch (cause) {
      setError((cause as Error).message);
      setBusy(false);
    }
  }

  return (
    <div className="account-portable-import">
      <strong>Перенести архив в пустое дерево</strong>
      <p>
        Фото, документы, источники и обсуждения будут проверены перед импортом.
      </p>
      <label>
        Файл .drevo
        <input
          type="file"
          accept=".drevo"
          disabled={busy}
          onChange={(event) => {
            setFile(event.target.files?.[0] || null);
            setPreview(null);
            setError("");
          }}
        />
      </label>
      <button
        type="button"
        disabled={!file || busy}
        onClick={() => void inspect()}
      >
        {busy && !preview ? "Проверяем…" : "Проверить файл"}
      </button>
      {preview && (
        <div className="account-portable-preview">
          <strong>{preview.title}</strong>
          <span>
            {preview.people} человек · {preview.photos} фото ·{" "}
            {preview.documents} документов · {preview.comments} обсуждений
          </span>
          <button type="button" disabled={busy} onClick={() => void apply()}>
            {busy ? "Импортируем…" : "Импортировать в это дерево"}
          </button>
        </div>
      )}
      {error && (
        <p className="account-error" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}
