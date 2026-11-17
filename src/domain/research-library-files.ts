import type { ResearchAttachment } from "../shared/research-attachments.ts";
import type { GeneratedResearchFileMeta, ResearchFile } from "../shared/research-protocol.ts";

export type ResearchLibraryFile = ResearchFile & {
  size?: number;
  expires?: number;
  canAsk: boolean;
};

export function researchDownload(file: ResearchFile, metadata?: readonly GeneratedResearchFileMeta[]) {
  const meta = metadata?.find(item => item.url === file.url);
  return { ...file, ...(meta && { size: meta.size, expires: meta.expires }) };
}

/** A repeated download stays one library item; retain known upload metadata. */
export function researchLibraryFiles(messages: readonly {
  role: string;
  attachments?: ResearchAttachment[];
  files?: ResearchFile[];
  generatedFileMeta?: GeneratedResearchFileMeta[];
}[]): ResearchLibraryFile[] {
  const files = new Map<string, ResearchLibraryFile>();
  for (const message of messages) {
    for (const file of message.attachments ?? []) {
      if (file.url) files.set(file.url, {
        name: file.name, url: file.url, size: file.size, canAsk: true,
      });
    }
    if (message.role !== "assistant") continue;
    for (const file of message.files ?? []) {
      if (!file.url || files.get(file.url)?.canAsk) continue;
      files.set(file.url, {
        ...files.get(file.url), ...researchDownload(file, message.generatedFileMeta), canAsk: false,
      });
    }
  }
  return [...files.values()];
}
