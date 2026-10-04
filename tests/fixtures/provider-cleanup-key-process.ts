import { DatabaseSync } from "node:sqlite";
import { aiProviderCleanup } from "../../src/server/ai-provider-cleanup.ts";
import { initializeArchiveSchema } from "../../src/server/schema.ts";
import { storeDatabase } from "../../src/server/store-database.ts";

const database = new DatabaseSync(process.argv[2]);
try {
  initializeArchiveSchema(database);
  await aiProviderCleanup(storeDatabase(database), process.argv[3]);
} finally {
  database.close();
}
