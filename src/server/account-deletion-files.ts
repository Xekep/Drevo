import { lstat } from "node:fs/promises";
import { dirname, join } from "node:path";
import { aiAttachmentStore } from "./ai-attachments.ts";
import { aiChatStore } from "./ai-chats.ts";
import { archiveDeletionDirectory } from "./archive-deletion-files.ts";
import { generatedResearchFileStore } from "./generated-research-files.ts";
import type { StoreDatabase } from "./store-database.ts";

type DeletedChat = { archiveId: string; chatId: string };
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;

async function remains(path: string) {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

/** The account row has committed away; only its former chat directories may be removed. */
export async function removeDeletedAccountAiFiles(
  db: StoreDatabase,
  aiChats: DeletedChat[],
) {
  const chats = aiChatStore(db);
  const failures: unknown[] = [];
  for (const { archiveId, chatId } of aiChats) {
    if (!uuid.test(chatId)) continue; // Legacy non-UUID chats cannot own file paths.
    try {
      const archive = archiveId === db.archiveId
        ? dirname(db.file)
        : archiveDeletionDirectory(db.file, archiveId).directory;
      const uploads = join(archive, "uploads");
      await aiAttachmentStore(uploads, chats).deleteChat(chatId);
      await generatedResearchFileStore(db, uploads, chats).deleteChat(chatId);
      if (await remains(join(uploads, "ai-chat-files", chatId)) ||
        await remains(join(archive, "ai-generated-files", chatId)))
        throw new Error("AI chat files remain after account deletion");
    } catch (error) {
      failures.push(error);
    }
  }
  if (failures.length)
    throw new AggregateError(failures, "Could not remove all deleted account AI files");
}
