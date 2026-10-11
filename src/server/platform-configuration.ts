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
    throw new Error(
      "Platform configuration must be initialized from the primary archive",
    );
  if (!db.postgresTransaction)
    throw new Error("PostgreSQL transaction unavailable");
  await db.postgresTransaction(async (client) => {
    await client.query("SELECT pg_advisory_xact_lock(186743291)");
    await client.query(
      readFileSync(
        new URL(
          "../../ops/postgres/091_platform_configuration.sql",
          import.meta.url,
        ),
        "utf8",
      ),
    );
    await client.query(
      readFileSync(
        new URL(
          "../../ops/postgres/095_platform_email_auth.sql",
          import.meta.url,
        ),
        "utf8",
      ),
    );
    await client.query(
      readFileSync(
        new URL(
          "../../ops/postgres/096_platform_accounts_directory.sql",
          import.meta.url,
        ),
        "utf8",
      ),
    );
    await client.query(
      readFileSync(
        new URL("../../ops/postgres/099_platform_ai.sql", import.meta.url),
        "utf8",
      ),
    );
    const aiInstalled = await client.query(
      "SELECT 1 FROM platform_config_migrations WHERE version=99",
    );
    if (!aiInstalled.rowCount) {
      // Only the primary archive's credentials are promoted. Its existing
      // ciphertext continues using the primary .secrets.key; never select a
      // tenant's private credential or decrypt it with another archive's key.
      await client.query(`INSERT INTO platform_ai_settings
        (id,enabled,model,folder_id,api_key_ciphertext,requests_per_minute,
         daily_requests,daily_tokens,compaction_enabled,compact_threshold_tokens,
         automatic_truncation,max_tool_iterations,web_search_enabled,
         code_interpreter_enabled,role_profiles)
        SELECT id,enabled,model,folder_id,api_key_ciphertext,requests_per_minute,
         daily_requests,daily_tokens,compaction_enabled,compact_threshold_tokens,
         automatic_truncation,max_tool_iterations,web_search_enabled,
         code_interpreter_enabled,role_profiles FROM ai_settings WHERE id=1
        ON CONFLICT DO NOTHING`);
      const archiveIds = new Set([primaryArchiveId]);
      // The account-directory policies permit listing one account's trees.
      // Startup enumerates the known accounts and preserves archive FORCE RLS.
      const accounts = await client.query<{ id: string }>(
        "SELECT id FROM accounts ORDER BY id",
      );
      for (const account of accounts.rows) {
        await client.query("SELECT set_config('drevo.account_id',$1,true)", [
          account.id,
        ]);
        const memberships = await client.query<{ archive_id: string }>(
          "SELECT archive_id FROM archive_memberships WHERE user_id=$1",
          [account.id],
        );
        for (const membership of memberships.rows)
          archiveIds.add(membership.archive_id);
      }
      await client.query("SELECT set_config('drevo.account_id','',true)");
      for (const id of archiveIds) {
        // Retain FORCE RLS: the migration enters each known archive rather than
        // installing a privileged cross-archive reader callable by requests.
        await client.query("SELECT set_config('drevo.archive_id',$1,true)", [
          id,
        ]);
        await client.query(`INSERT INTO platform_ai_usage
          (archive_id,source_usage_id,at,started_ms,user_id,model,status,
           provider_calls,input_tokens,output_tokens,total_tokens,latency_ms,cached_input_tokens)
          SELECT archive_id,id,at,started_ms,
            CASE WHEN EXISTS(SELECT 1 FROM deleted_account_tombstones t WHERE t.id=u.user_id)
              THEN 'deleted-account' ELSE user_id END,
            model,status,provider_calls,input_tokens,output_tokens,total_tokens,latency_ms,cached_input_tokens
          FROM ai_usage u ON CONFLICT(archive_id,source_usage_id) DO NOTHING`);
        await client.query(`INSERT INTO platform_ai_usage_models
          (usage_id,model,provider_calls,input_tokens,output_tokens,total_tokens)
          SELECT ledger.id,m.model,m.provider_calls,m.input_tokens,m.output_tokens,m.total_tokens
          FROM ai_usage_models m JOIN platform_ai_usage ledger
            ON ledger.archive_id=m.archive_id AND ledger.source_usage_id=m.usage_id
          ON CONFLICT DO NOTHING`);
      }
      await client.query("SELECT set_config('drevo.archive_id',$1,true)", [
        primaryArchiveId,
      ]);
      await client.query(
        "INSERT INTO platform_config_migrations(version) VALUES(99)",
      );
    }
    const installed = await client.query(
      "SELECT 1 FROM platform_config_migrations WHERE version=91",
    );
    if (installed.rowCount) return;
    // The connection belongs to the primary archive. FORCE RLS on these old
    // tables prevents another archive's custom URLs from becoming public.
    await client.query(`INSERT INTO platform_upload_limits(id,data)
      SELECT id,data FROM upload_limits WHERE id=1 ON CONFLICT DO NOTHING`);
    await client.query(
      `INSERT INTO platform_upload_limits(id,data) VALUES(1,$1)
      ON CONFLICT DO NOTHING`,
      [JSON.stringify(DEFAULT_STORAGE_LIMITS)],
    );
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
            [
              randomUUID(),
              categoryId,
              resource.name,
              resource.url,
              resource.description,
              resourceOrder,
            ],
          );
      }
    }
    await client.query(
      "INSERT INTO platform_config_migrations(version) VALUES(91)",
    );
  });
}
