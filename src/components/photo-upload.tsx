import { useEffect, useState } from "react";
import { ImagePlus, ScanFace, Upload } from "lucide-react";
import type { Family, PhotoMetadata } from "../domain";
import { EditorDialog } from "./editor-dialog";

export function PhotoUpload({
  upload,
  onClose,
  onUploaded,
  busy,
}: {
  upload: (file: File, metadata?: PhotoMetadata) => Promise<Family>;
  onClose: () => void;
  onUploaded: (id: string) => void;
  busy: boolean;
}) {
  const [file, setFile] = useState<File | null>(null),
    [preview, setPreview] = useState(""),
    [metadata, setMetadata] = useState<PhotoMetadata>({}),
    [error, setError] = useState("");
  useEffect(
    () => () => {
      if (preview) URL.revokeObjectURL(preview);
    },
    [preview],
  );
  function choose(next?: File) {
    if (!next || busy) return;
    if (
      !/^image\/(jpeg|png|webp|gif)$/.test(next.type) ||
      next.size > 20 * 1024 * 1024
    ) {
      setError("Выберите JPG, PNG, WebP или GIF размером до 20 МБ.");
      return;
    }
    setError("");
    setFile(next);
    setPreview(URL.createObjectURL(next));
  }
  return (
    <EditorDialog
      title="Добавить фотографию"
      onClose={() => {
        if (!busy) onClose();
      }}
      wide
    >
      <form
        className="archive-form"
        onSubmit={async (e) => {
          e.preventDefault();
          if (!file) return;
          setError("");
          try {
            const next = await upload(file, metadata);
            onUploaded(next.photos![next.photos!.length - 1].id);
            onClose();
          } catch (e) {
            setError((e as Error).message);
          }
        }}
      >
        <p className="flow-intro">
          Сначала снимок и его история. Затем — отметки людей.
        </p>
        <div className="upload-layout">
          <label
            className={`photo-dropzone ${preview ? "has-preview" : ""}`}
            onDragOver={(e) => e.preventDefault()}
            onDrop={(e) => {
              e.preventDefault();
              choose(e.dataTransfer.files[0]);
            }}
          >
            {preview ? (
              <img src={preview} alt="Предпросмотр выбранного снимка" />
            ) : (
              <ImagePlus size={44} strokeWidth={1.2} />
            )}
            <b>
              {file ? "Выбрать другой снимок" : "Перетащите фотографию сюда"}
            </b>
            <span>
              {file ? file.name : "или нажмите, чтобы выбрать файл · до 20 МБ"}
            </span>
            <input
              className="file-picker"
              type="file"
              aria-label="Выбрать фотографию"
              accept="image/jpeg,image/png,image/webp,image/gif"
              disabled={busy}
              onChange={(e) => choose(e.target.files?.[0])}
            />
          </label>
          <div className="photo-upload-fields">
            <div className="form-grid">
              <label>
                Год{" "}
                <input
                  inputMode="numeric"
                  pattern="[0-9]{4}"
                  maxLength={4}
                  placeholder="1965"
                  value={metadata.year || ""}
                  onChange={(e) =>
                    setMetadata({ ...metadata, year: e.target.value })
                  }
                />
              </label>
              <label>
                Место{" "}
                <input
                  maxLength={200}
                  placeholder="Город или деревня"
                  value={metadata.place || ""}
                  onChange={(e) =>
                    setMetadata({ ...metadata, place: e.target.value })
                  }
                />
              </label>
            </div>
            <label>
              Событие{" "}
              <input
                maxLength={200}
                placeholder="Свадьба, день рождения, встреча"
                value={metadata.event || ""}
                onChange={(e) =>
                  setMetadata({ ...metadata, event: e.target.value })
                }
              />
            </label>
            <label>
              История снимка{" "}
              <textarea
                rows={3}
                maxLength={500}
                placeholder="Что хочется сохранить в памяти"
                value={metadata.description || ""}
                onChange={(e) =>
                  setMetadata({ ...metadata, description: e.target.value })
                }
              />
            </label>
            <p className="field-hint">
              Неизвестные сведения можно пропустить и добавить позже.
            </p>
          </div>
        </div>
        <div className="scan-explainer">
          <ScanFace size={22} />
          <p>
            <b>Поможем отметить людей</b>
            <br />
            После сохранения найдём лица и предложим рамки. Выберите человека
            для каждой отметки.
          </p>
        </div>
        {error && (
          <p role="alert" className="form-error">
            {error}
          </p>
        )}
        <footer>
          <button className="primary-action" disabled={!file || busy}>
            <Upload size={16} />
            {busy ? "Сохраняем снимок…" : "Сохранить и отметить людей"}
          </button>
          <button type="button" disabled={busy} onClick={onClose}>
            Отмена
          </button>
        </footer>
      </form>
    </EditorDialog>
  );
}
