import { useEffect, useRef, useState } from "react";
import { ImagePlus, ScanFace, Upload } from "lucide-react";
import type { Family, PhotoMetadata } from "../domain";
import { EditorDialog } from "./editor-dialog";
import { photoFileError } from "../domain/photo-upload";
import { PlaceField } from "./place-field";
import {
  confirmDiscardChanges,
  useUnsavedChanges,
} from "../hooks/useUnsavedChanges";

export function PhotoUpload({
  upload,
  onClose,
  onUploaded,
  busy,
  initialFile,
}: {
  upload: (file: File, metadata?: PhotoMetadata) => Promise<Family>;
  onClose: () => void;
  onUploaded: (id: string) => void;
  busy: boolean;
  initialFile?: File | null;
}) {
  const [file, setFile] = useState<File | null>(() =>
      initialFile && !photoFileError(initialFile) ? initialFile : null,
    ),
    [metadata, setMetadata] = useState<PhotoMetadata>({}),
    [error, setError] = useState("");
  const preview = useRef<HTMLImageElement>(null);
  const dirty = !!file || Object.values(metadata).some(Boolean);
  useUnsavedChanges(dirty);
  const close = () => {
    if (!busy && confirmDiscardChanges(dirty)) onClose();
  };
  useEffect(() => {
    if (!file) return;
    const url = URL.createObjectURL(file);
    if (preview.current) preview.current.src = url;
    return () => URL.revokeObjectURL(url);
  }, [file]);
  function choose(next?: File) {
    if (!next || busy) return;
    const problem = photoFileError(next);
    if (problem) {
      setError(problem);
      return;
    }
    setError("");
    setFile(next);
  }
  return (
    <EditorDialog
      title="Добавить фотографию"
      onClose={close}
      wide
      className="photo-upload-dialog"
    >
      <form
        className="archive-form photo-upload-form"
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
        <div className="upload-layout">
          <label
            className={`photo-dropzone ${file ? "has-preview" : ""}`}
            onDragOver={(e) => e.preventDefault()}
            onDrop={(e) => {
              e.preventDefault();
              choose(e.dataTransfer.files[0]);
            }}
          >
            {file ? (
              <img ref={preview} alt="Предпросмотр выбранного снимка" />
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
            <p className="flow-intro">
              Сначала снимок и его история. Затем — отметки людей.
            </p>
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
              <PlaceField
                label="Место"
                maxLength={200}
                value={metadata.place || ""}
                onChange={(place) => setMetadata({ ...metadata, place })}
              />
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
            <div className="scan-explainer">
              <ScanFace size={22} />
              <p>
                <b>Поможем отметить людей</b>
                <br />
                После сохранения найдём лица и предложим рамки. Выберите
                человека для каждой отметки.
              </p>
            </div>
            {error && (
              <p role="alert" className="form-error">
                {error}
              </p>
            )}
          </div>
        </div>
        <footer>
          <button className="primary-action" disabled={!file || busy}>
            <Upload size={16} />
            {busy ? "Сохраняем снимок…" : "Сохранить и отметить людей"}
          </button>
          <button
            type="button"
            className="text-action"
            disabled={busy}
            onClick={close}
          >
            Закрыть
          </button>
        </footer>
      </form>
    </EditorDialog>
  );
}
