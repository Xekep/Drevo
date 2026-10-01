import { FileText, Download } from "lucide-react";
import { archiveResourceUrl } from "../../domain/archive-context";
import type { CommentAttachment } from "../../shared/person-discussion";
import { attachmentSize } from "./attachment-composer";

export function MessageAttachments({
  files,
  onOpen,
}: {
  files: CommentAttachment[];
  onOpen: (images: CommentAttachment[], id: string) => void;
}) {
  const images = files.filter((file) => file.previewUrl);
  return (
    files.length > 0 && (
      <div className="discussion-message-attachments">
        {images.length > 0 && (
          <div className="discussion-image-previews">
            {images.map((file) => (
              <button
                type="button"
                key={file.id}
                aria-label={`Открыть изображение: ${file.name}`}
                onClick={() => onOpen(images, file.id)}
              >
                <img
                  src={archiveResourceUrl(file.previewUrl!)}
                  alt={file.name}
                  loading="lazy"
                />
                <span>{file.name}</span>
              </button>
            ))}
          </div>
        )}
        {files
          .filter((file) => !file.previewUrl)
          .map((file) => (
            <a
              className="discussion-file"
              key={file.id}
              href={archiveResourceUrl(`${file.url}?download=1`)}
              download={file.name}
            >
              <FileText size={22} aria-hidden="true" />
              <span>
                {file.name}
                <small>{attachmentSize(file.size)}</small>
              </span>
              <Download size={15} aria-hidden="true" />
            </a>
          ))}
      </div>
    )
  );
}
