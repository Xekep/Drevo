import { FileText, Paperclip } from "lucide-react";
import type { ResearchAttachment } from "../../shared/research-attachments.ts";
import { archiveResourceUrl } from "../../domain/archive-context.ts";

export function AttachmentLibrary({
  files,
  onAsk,
}: {
  files: ResearchAttachment[];
  onAsk: (name: string) => void;
}) {
  return (
    <section
      className="research-attachment-library"
      aria-label="Библиотека вложений"
    >
      <h3>
        Вложения диалога <small>{files.length}</small>
      </h3>
      <p>
        Ассистент может обратиться к этим файлам по вашей просьбе. При удалении
        диалога библиотека удаляется вместе с ним.
      </p>
      {!files.length ? (
        <div className="research-library-empty">
          <Paperclip size={26} />
          <span>
            Пока нет файлов. Добавьте их скрепкой или перетащите в окно, затем
            отправьте сообщение.
          </span>
        </div>
      ) : (
        <ul>
          {files.map((file) => (
            <li key={file.url}>
              <FileText size={20} />
              <div>
                <a href={archiveResourceUrl(file.url)} download={file.name}>
                  {file.name}
                </a>
                <small>{Math.max(1, Math.round(file.size / 1024))} КБ</small>
                <button type="button" onClick={() => onAsk(file.name)}>
                  Спросить об этом файле
                </button>
              </div>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
