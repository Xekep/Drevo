import { dirname, join } from "node:path";
import { aiChatStore } from "../../src/server/ai-chats.ts";
import { generatedResearchFileStore } from "../../src/server/generated-research-files.ts";
import { openPostgresDatabase } from "../../src/server/store-database.ts";

const [source, chatId] = process.argv.slice(2);
if (!source || !chatId || process.env.DATABASE_BACKEND !== "postgres" ||
  !/^drevo_migration_runtime_[a-z0-9_]+$/.test(process.env.PGDATABASE || "") ||
  !process.send)
  throw new Error("Generated-file cap worker requires the disposable runtime database");

const db = await openPostgresDatabase(process.env.ARCHIVE_ID || "runtime-test", source);
const store = generatedResearchFileStore(db, join(dirname(source), "uploads"), aiChatStore(db));
process.send?.({ ready: true });
process.on("message", (message) => {
  if (message !== "start") return;
  void (async () => {
    try {
      const link = await store.save({
        ownerId: "owner", chatId, name: "cap.pdf", contentType: "application/pdf",
        bytes: Buffer.alloc(34 * 1024 * 1024, 0x50), expires: Date.now() + 30 * 60_000,
      });
      await new Promise<void>((resolve, reject) => process.send!(
        { saved: !!link, url: link?.url },
        (error) => error ? reject(error) : resolve(),
      ));
    } catch (error) {
      await new Promise<void>((resolve, reject) => process.send!(
        { error: String(error) },
        (sendError) => sendError ? reject(sendError) : resolve(),
      ));
    } finally {
      store.close();
      await db.close();
      process.disconnect();
    }
  })();
});
