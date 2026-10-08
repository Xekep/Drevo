import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import type { StoreDatabase } from "./store-database.ts";
import { researchCatalogSeed } from "./research-catalog-seed.ts";
import { DEFAULT_STORAGE_LIMITS } from "../shared/storage-limits.ts";

/** Only the primary archive calls this before opening any selected archive. */
export async function initializePlatformConfiguration(
  db: StoreDatabase,
  primaryArchiveId: string,
) {
  if (db.kind !== "postgres") return;
  if (!primaryArchiveId || db.archiveId !== primaryArchiveId)
    throw new Error("Platform configuration must be initialized from the primary archive");
  if (!db.postgresTransaction) throw new Error("PostgreSQL transaction unavailable");
  await db.postgresTransaction(async (client) => {
    await client.query("SELECT pg_advisory_xact_lock(186743291)");
    await client.query(readFileSync(
      new URL("../../ops/postgres/091_platform_configuration.sql", import.meta.url),
      "utf8",
    ));
    await client.query(readFileSync(
      new URL("../../ops/postgres/095_platform_email_auth.sql", import.meta.url),
      "utf8",
    ));
    await client.query(readFileSync(
      new URL("../../ops/postgres/096_platform_accounts_directory.sql", import.meta.url),
      "utf8",
    ));
    const installed = await client.query(
      "SELECT 1 FROM platform_config_migrations WHERE version=91",
    );
    if (installed.rowCount) return;
    // The connection belongs to the primary archive. FORCE RLS on these old
    // tables prevents another archive's custom URLs from becoming public.
    await client.query(`INSERT INTO platform_upload_limits(id,data)
      SELECT id,data FROM upload_limits WHERE id=1 ON CONFLICT DO NOTHING`);
    await client.query(`INSERT INTO platform_upload_limits(id,data) VALUES(1,$1)
      ON CONFLICT DO NOTHING`, [JSON.stringify(DEFAULT_STORAGE_LIMITS)]);
    await client.query(`INSERT INTO platform_vk_auth_settings(id,enabled,client_id)
      SELECT id,enabled,client_id FROM vk_auth_settings WHERE id=1 ON CONFLICT DO NOTHING`);
    await client.query(`INSERT INTO platform_research_categories(id,name,sort_order)
      SELECT id,name,sort_order FROM research_categories ON CONFLICT DO NOTHING`);
    await client.query(`INSERT INTO platform_research_resources
      (id,category_id,name,url,description,sort_order,ai_search)
      SELECT id,category_id,name,url,description,sort_order,ai_search
        FROM research_resources ON CONFLICT DO NOTHING`);
    const count = await client.query<{ n: string }>(
      "SELECT count(*) AS n FROM platform_research_categories",
    );
    if (Number(count.rows[0]?.n) === 0) {
      for (const [order, category] of researchCatalogSeed.entries()) {
        const categoryId = randomUUID();
        await client.query(
          "INSERT INTO platform_research_categories(id,name,sort_order) VALUES($1,$2,$3)",
          [categoryId, category.name, order],
        );
        for (const [resourceOrder, resource] of category.resources.entries())
          await client.query(
            `INSERT INTO platform_research_resources
              (id,category_id,name,url,description,sort_order,ai_search)
             VALUES($1,$2,$3,$4,$5,$6,NULL)`,
            [randomUUID(), categoryId, resource.name, resource.url,
              resource.description, resourceOrder],
          );
      }
    }
    await client.query("INSERT INTO platform_config_migrations(version) VALUES(91)");
  });
}
