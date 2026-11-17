import { FileText, Paperclip } from "lucide-react";
import type { ResearchLibraryFile } from "../../domain/research-library-files.ts";
import { ResearchDownload } from "./research-download";

export function AttachmentLibrary({
  files,
  onAsk,
  onExportTreePdf,
}: {
  files: ResearchLibraryFile[];
  onAsk: (name: string) => void;
  onExportTreePdf?: (scope: "all" | "current") => void;
}) {
  return (
    <section
      className="research-attachment-library"
      aria-label="Библиотека вложений"
    >
      <h3>
        Вложения диалога <small>{files.length}</small>
      </h3>
      {!files.length ? (
        <div className="research-library-empty">
          <Paperclip size={26} />
          <span>
            Пока нет файлов. Здесь появятся ваши вложения и файлы из ответов ИИ.
          </span>
        </div>
      ) : (
        <ul>
          {files.map((file) => (
            <li key={file.url}>
              <FileText size={20} />
              <div>
                <ResearchDownload file={file} onExportTreePdf={onExportTreePdf} />
                {file.size !== undefined && <small>{Math.max(1, Math.round(file.size / 1024))} КБ</small>}
                {file.canAsk && <button type="button" onClick={() => onAsk(file.name)}>
                  Спросить об этом файле
                </button>}
              </div>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
