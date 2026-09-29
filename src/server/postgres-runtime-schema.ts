import { readFileSync } from "node:fs";
import type { StoreDatabase } from "./store-database.ts";

/** Additive extension: the preceding release can still run after deployment. */
export async function initializePostgresRuntimeSchema(db: StoreDatabase) {
  for (const [query, file] of [
    [
      "SELECT to_regclass('vk_auth_settings') AS present",
      "011_vk_auth_settings.sql",
    ],
    [
      "SELECT 1 AS present FROM information_schema.columns WHERE table_schema=current_schema() AND table_name='ai_settings' AND column_name='role_profiles'",
      "012_ai_role_profiles.sql",
    ],
  ]) {
    if ((await db.prepare("", query).get())?.present) continue;
    await db.transaction(async () => {
      // Serialize DDL across processes/archives, not only this archive's writes.
      await db.exec("", "SELECT pg_advisory_xact_lock(186743291)");
      if ((await db.prepare("", query).get())?.present) return;
      await db.exec(
        "",
        readFileSync(
          new URL(`../../ops/postgres/${file}`, import.meta.url),
          "utf8",
        ),
      );
    });
  }
}
