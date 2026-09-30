import { useRef, useState, type DragEvent } from "react";
import {
  attachmentSelectionError,
  type AttachmentInput,
} from "../../shared/research-attachments.ts";

export function useResearchAttachments(
  disabled: boolean,
  onError: (message: string) => void,
  capabilities?: { photoAnalysis: boolean; codeInterpreter: boolean },
) {
  const [files, setFiles] = useState<File[]>([]);
  const [dragging, setDragging] = useState(false);
  const depth = useRef(0);
  const input = useRef<HTMLInputElement>(null);
  function add(incoming: File[]) {
    if (disabled) {
      onError(
        "Дождитесь завершения ответа или остановите его перед добавлением файлов.",
      );
      return;
    }
    if (
      capabilities?.photoAnalysis === false &&
      incoming.some((file) => /\.(?:jpe?g|png|webp)$/i.test(file.name))
    ) {
      onError("Анализ фотографий отключён для вашей роли.");
      return;
    }
    if (
      capabilities?.codeInterpreter === false &&
      incoming.some((file) => /\.xlsx$/i.test(file.name))
    ) {
      onError("Для XLSX администратор должен включить Code Interpreter.");
      return;
    }
    const next = [...files];
    for (const file of incoming) {
      if (
        !next.some(
          (item) =>
            item.name === file.name &&
            item.size === file.size &&
            item.lastModified === file.lastModified,
        )
      )
        next.push(file);
    }
    const error = attachmentSelectionError(next);
    if (error) {
      onError(error);
      return;
    }
    setFiles(next);
    onError("");
  }
  const isFileDrag = (event: DragEvent) =>
    event.dataTransfer.types.includes("Files");
  return {
    files,
    setFiles,
    input,
    dragging,
    add,
    dragEvents: {
      onDragEnter(event: DragEvent) {
        if (!isFileDrag(event)) return;
        event.preventDefault();
        event.stopPropagation();
        depth.current++;
        setDragging(true);
      },
      onDragOver(event: DragEvent) {
        if (!isFileDrag(event)) return;
        event.preventDefault();
        event.stopPropagation();
        event.dataTransfer.dropEffect = disabled ? "none" : "copy";
      },
      onDragLeave(event: DragEvent) {
        if (!isFileDrag(event)) return;
        event.preventDefault();
        event.stopPropagation();
        depth.current = Math.max(0, depth.current - 1);
        if (!depth.current) setDragging(false);
      },
      onDrop(event: DragEvent) {
        if (!isFileDrag(event)) return;
        event.preventDefault();
        event.stopPropagation();
        depth.current = 0;
        setDragging(false);
        add(Array.from(event.dataTransfer.files));
      },
    },
  };
}

export async function encodeResearchFiles(
  files: File[],
): Promise<AttachmentInput[]> {
  return await Promise.all(
    files.map(
      (file) =>
        new Promise<AttachmentInput>((resolve, reject) => {
          const reader = new FileReader();
          reader.onload = () =>
            resolve({
              name: file.name,
              data: String(reader.result).split(",")[1],
            });
          reader.onerror = () =>
            reject(new Error(`Не удалось прочитать ${file.name}`));
          reader.readAsDataURL(file);
        }),
    ),
  );
}
