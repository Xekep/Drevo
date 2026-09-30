import { readFileSync } from "node:fs";
import type { StoreDatabase } from "./store-database.ts";

/** Additive extension: the preceding release can still run after deployment. */
export async function initializePostgresRuntimeSchema(db: StoreDatabase) {
  for (const [query, file] of [
    [
      "SELECT to_regclass('archive_invitations') AS present",
      "023_archive_invitations.sql",
    ],
    [
      "SELECT 1 AS present FROM pg_policies WHERE schemaname=current_schema() AND tablename='archive_owners' AND policyname='account_owners_read'",
      "022_account_owner_directory.sql",
    ],
    [
      "SELECT 1 AS present FROM pg_policies WHERE schemaname=current_schema() AND tablename='archive_memberships' AND policyname='account_memberships_read'",
      "021_account_archive_directory.sql",
    ],
    [
      "SELECT 1 AS present FROM information_schema.columns WHERE table_schema=current_schema() AND table_name='ai_settings' AND column_name='code_interpreter_enabled'",
      "020_code_interpreter.sql",
    ],
    [
      "SELECT to_regclass('vk_auth_settings') AS present",
      "011_vk_auth_settings.sql",
    ],
    [
      "SELECT 1 AS present FROM information_schema.columns WHERE table_schema=current_schema() AND table_name='ai_settings' AND column_name='role_profiles'",
      "012_ai_role_profiles.sql",
    ],
    [
      "SELECT 1 AS present FROM information_schema.columns WHERE table_schema=current_schema() AND table_name='documents' AND column_name='annotations'",
      "013_document_annotations.sql",
    ],
    [
      "SELECT 1 AS present FROM information_schema.columns WHERE table_schema=current_schema() AND table_name='people' AND column_name='surname_search'",
      "014_family_indexed_fields.sql",
    ],
    [
      "SELECT to_regclass('media_originals') AS present",
      "015_media_originals.sql",
    ],
    [
      "SELECT to_regclass('platform_admins') AS present",
      "016_platform_admins.sql",
    ],
    [
      "SELECT 1 AS present FROM information_schema.columns WHERE table_schema=current_schema() AND table_name='documents' AND column_name='document_type'",
      "017_document_metadata.sql",
    ],
    [
      "SELECT to_regclass('share_link_activity') AS present",
      "018_share_link_activity.sql",
    ],
    [
      "SELECT to_regclass('published_people') AS present",
      "019_published_people.sql",
    ],
    [
      "SELECT to_regclass('discovery_people') AS present",
      "024_discovery_people.sql",
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
