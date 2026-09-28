import { readFileSync } from "node:fs";
import type { StoreDatabase } from "./store-database.ts";

/** Additive extension: the preceding release can still run after deployment. */
export async function initializePostgresRuntimeSchema(db: StoreDatabase) {
  if (
    (
      await db
        .prepare("", "SELECT to_regclass('vk_auth_settings') AS relation")
        .get()
    )?.relation
  )
    return;
  await db.transaction(async () => {
    // Serialize DDL across processes/archives, not only this archive's writes.
    await db.exec("", "SELECT pg_advisory_xact_lock(186743291)");
    if (
      (
        await db
          .prepare("", "SELECT to_regclass('vk_auth_settings') AS relation")
          .get()
      )?.relation
    )
      return;
    await db.exec(
      "",
      readFileSync(
        new URL("../../ops/postgres/011_vk_auth_settings.sql", import.meta.url),
        "utf8",
      ),
    );
  });
}
