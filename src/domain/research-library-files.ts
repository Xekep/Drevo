import type { ResearchAttachment } from "../shared/research-attachments.ts";

export type ResearchLibraryFile = Pick<ResearchAttachment, "name" | "url"> &
  Partial<Pick<ResearchAttachment, "size" | "type">>;

/** A repeated download stays one library item; retain known upload metadata. */
export function researchLibraryFiles(messages: readonly {
  role: string;
  attachments?: ResearchAttachment[];
  files?: { name: string; url: string }[];
}[]): ResearchLibraryFile[] {
  const files = new Map<string, ResearchLibraryFile>();
  for (const message of messages)
    for (const file of [...(message.attachments || []),
      ...(message.role === "assistant" ? message.files || [] : [])]) {
      if (!file.url) continue;
      files.set(file.url, { ...files.get(file.url), ...file });
    }
  return [...files.values()];
}
