export const AI_ATTACHMENT_COUNT = 3;
export const AI_CHAT_LIMIT = 10;
export const AI_ATTACHMENT_BYTES = 5 * 1024 * 1024;
export const AI_ATTACHMENTS_BYTES = 10 * 1024 * 1024;
export const AI_ATTACHMENT_ACCEPT =
  ".pdf,.jpg,.jpeg,.png,.webp,.txt,.md,.csv,.tsv,.json,.ged,.xlsx";
export const AI_ATTACHMENT_HINT =
  "PDF, фото, текст, CSV, JSON, GEDCOM, XLSX · до 3 файлов, 5 МБ каждый, 10 МБ вместе";
export type ResearchAttachment = {
  name: string;
  url: string;
  size: number;
  type: string;
};
export type AttachmentInput = { name: string; data: string };

export function attachmentSelectionError(
  files: Array<{ name: string; size: number }>,
) {
  if (files.length > AI_ATTACHMENT_COUNT)
    return "Можно прикрепить не больше 3 файлов.";
  if (
    files.some(
      (file) =>
        !AI_ATTACHMENT_ACCEPT.split(",").some((extension) =>
          file.name.toLowerCase().endsWith(extension),
        ),
    )
  )
    return "Этот формат не поддерживается. " + AI_ATTACHMENT_HINT;
  if (files.some((file) => !file.size || file.size > AI_ATTACHMENT_BYTES))
    return "Файл должен быть непустым и не больше 5 МБ.";
  if (files.reduce((size, file) => size + file.size, 0) > AI_ATTACHMENTS_BYTES)
    return "Общий размер вложений — не больше 10 МБ.";
  return "";
}
