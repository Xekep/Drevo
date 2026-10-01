import { useEffect, useRef } from "react";
import { Paperclip, X, FileText } from "lucide-react";
import { archiveResourceUrl } from "../../domain/archive-context";
import {
  COMMENT_FILE_ACCEPT,
  MAX_COMMENT_FILES,
  MAX_COMMENT_FILE_BYTES,
  MAX_COMMENT_FILES_BYTES,
  type CommentAttachment,
} from "../../shared/person-discussion";

export function attachmentSize(bytes: number) {
  return bytes >= 1024 * 1024
    ? `${(bytes / (1024 * 1024)).toFixed(1)} МБ`
    : `${Math.max(1, Math.round(bytes / 1024))} КБ`;
}

function SelectedFile({ file }: { file: File }) {
  const image = useRef<HTMLImageElement>(null);
  useEffect(() => {
    if (!image.current) return;
    const preview = URL.createObjectURL(file);
    image.current.src = preview;
    return () => URL.revokeObjectURL(preview);
  }, [file]);
  return file.type.startsWith("image/") ? (
    <img ref={image} alt={file.name} />
  ) : (
    <FileText size={22} aria-hidden="true" />
  );
}

export function AttachmentComposer({
  files,
  retained = [],
  onChange,
  onRemoveRetained,
  disabled,
  onError,
}: {
  files: File[];
  retained?: CommentAttachment[];
  onChange: (files: File[]) => void;
  onRemoveRetained?: (id: string) => void;
  disabled: boolean;
  onError: (message: string) => void;
}) {
  const input = useRef<HTMLInputElement>(null);
  function select(selected: File[]) {
    const all = [...files, ...selected];
    if (all.length + retained.length > MAX_COMMENT_FILES)
      return onError("Можно прикрепить не больше 8 файлов.");
    if (
      selected.some((file) => !file.size || file.size > MAX_COMMENT_FILE_BYTES)
    )
      return onError("Размер каждого файла — от 1 байта до 10 МБ.");
    if (
      all.reduce((sum, file) => sum + file.size, 0) +
        retained.reduce((sum, file) => sum + file.size, 0) >
      MAX_COMMENT_FILES_BYTES
    )
      return onError("Общий размер вложений — не больше 20 МБ.");
    if (
      selected.some(
        (file) =>
          !COMMENT_FILE_ACCEPT.split(",").includes(
            `.${file.name.split(".").at(-1)?.toLowerCase()}`,
          ),
      )
    )
      return onError("Этот формат файла не поддерживается.");
    onError("");
    onChange(all);
  }
  return (
    <div className="discussion-attachment-composer">
      <input
        ref={input}
        type="file"
        multiple
        accept={COMMENT_FILE_ACCEPT}
        aria-label="Файлы для сообщения"
        disabled={disabled}
        onChange={(event) => {
          select(Array.from(event.target.files || []));
          event.target.value = "";
        }}
      />
      <button
        type="button"
        className="discussion-attach-button"
        disabled={disabled}
        onClick={() => input.current?.click()}
      >
        <Paperclip size={15} aria-hidden="true" /> Прикрепить файлы
      </button>
      {(files.length > 0 || retained.length > 0) && (
        <ul className="discussion-selected-files">
          {retained.map((file) => (
            <li key={file.id}>
              {file.previewUrl ? (
                <img
                  src={archiveResourceUrl(file.previewUrl)}
                  alt={file.name}
                />
              ) : (
                <FileText size={22} aria-hidden="true" />
              )}
              <span>
                {file.name}
                <small>{attachmentSize(file.size)}</small>
              </span>
              <button
                type="button"
                aria-label={`Убрать вложение: ${file.name}`}
                disabled={disabled}
                onClick={() => onRemoveRetained?.(file.id)}
              >
                <X size={14} aria-hidden="true" />
              </button>
            </li>
          ))}
          {files.map((file, index) => (
            <li key={`${file.name}:${file.lastModified}:${index}`}>
              <SelectedFile file={file} />
              <span>
                {file.name}
                <small>{attachmentSize(file.size)}</small>
              </span>
              <button
                type="button"
                aria-label={`Убрать вложение: ${file.name}`}
                disabled={disabled}
                onClick={() => onChange(files.filter((_, i) => i !== index))}
              >
                <X size={14} aria-hidden="true" />
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

export async function encodeCommentFiles(files: File[]) {
  return await Promise.all(
    files.map(
      (file) =>
        new Promise<{ name: string; data: string }>((resolve, reject) => {
          const reader = new FileReader();
          reader.onerror = () =>
            reject(new Error("Не удалось прочитать вложение"));
          reader.onload = () =>
            resolve({
              name: file.name,
              data: String(reader.result).split(",")[1],
            });
          reader.readAsDataURL(file);
        }),
    ),
  );
}
