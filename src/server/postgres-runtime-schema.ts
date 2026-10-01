import { readFileSync } from "node:fs";
import type { StoreDatabase } from "./store-database.ts";

/** Additive extension: the preceding release can still run after deployment. */
export async function initializePostgresRuntimeSchema(db: StoreDatabase) {
  for (const [query, file] of [
    ["SELECT to_regclass('family_unions') AS present", "047_family_unions.sql"],
    [
      "SELECT 1 AS present FROM information_schema.columns WHERE table_schema=current_schema() AND table_name='user_tree_preferences' AND column_name='generation_limits'",
      "046_tree_generation_limits.sql",
    ],
    [
      "SELECT to_regclass('source_catalog') AS present",
      "048_source_catalog.sql",
    ],
    [
      "SELECT 1 AS present FROM information_schema.columns WHERE table_schema=current_schema() AND table_name='documents' AND column_name='event_links'",
      "045_document_events_pages.sql",
    ],
    [
      "SELECT 1 AS present FROM information_schema.columns WHERE table_schema=current_schema() AND table_name='relations' AND column_name='twin_kind'",
      "044_family_link_types.sql",
    ],
    [
      "SELECT to_regclass('platform_upload_reservations') AS present",
      "043_platform_upload_reservations.sql",
    ],
    [
      "SELECT to_regclass('request_rate_limits') AS present",
      "042_request_rate_limits.sql",
    ],
    [
      "SELECT to_regclass('archive_owner_transfers') AS present",
      "039_archive_owner_transfers.sql",
    ],
    [
      "SELECT 1 AS present FROM pg_constraint WHERE conname='workflow_stages_kind_check' AND pg_get_constraintdef(oid) LIKE '%drevo%'",
      "038_portable_stage.sql",
    ],
    [
      "SELECT 1 AS present FROM information_schema.columns WHERE table_schema=current_schema() AND table_name='person_comments' AND column_name='author_name'",
      "037_comment_author_snapshot.sql",
    ],
    [
      "SELECT to_regclass('account_oauth_session_proofs') AS present",
      "036_oauth_session_proof.sql",
    ],
    [
      "SELECT to_regclass('pending_email_links') AS present",
      "035_pending_email_links.sql",
    ],
    [
      "SELECT to_regclass('email_auth_rate_limits') AS present",
      "034_email_auth_rate_limits.sql",
    ],
    [
      "SELECT to_regclass('account_email_credentials') AS present",
      "033_email_accounts.sql",
    ],
    ["SELECT to_regclass('upload_limits') AS present", "032_upload_limits.sql"],
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
    [
      "SELECT 1 AS present FROM information_schema.columns WHERE table_schema=current_schema() AND table_name='discovery_people' AND column_name='birth_surname'",
      "025_publication_fields.sql",
    ],
    [
      "SELECT to_regclass('discovery_match_requests') AS present",
      "026_discovery_matches.sql",
    ],
    [
      "SELECT 1 AS present FROM information_schema.columns WHERE table_schema=current_schema() AND table_name='discovery_people' AND column_name='name_vector'",
      "027_discovery_candidate_names.sql",
    ],
    [
      "SELECT 1 AS present WHERE to_regclass('discovery_linked_pairs') IS NOT NULL OR EXISTS (SELECT 1 FROM pg_policies WHERE schemaname=current_schema() AND tablename='discovery_match_requests' AND policyname='linked_discovery_read')",
      "028_linked_discovery_read.sql",
    ],
    [
      "SELECT 1 AS present FROM information_schema.columns WHERE table_schema=current_schema() AND table_name='discovery_match_requests' AND column_name='reason'",
      "029_discovery_match_reason.sql",
    ],
    [
      "SELECT to_regclass('discovery_ignored_candidates') AS present",
      "030_discovery_ignored_candidates.sql",
    ],
    [
      "SELECT to_regclass('discovery_ignored_archives') AS present",
      "031_discovery_ignored_archives.sql",
    ],
    [
      "SELECT 1 AS present FROM pg_trigger WHERE tgrelid=to_regclass('relations') AND tgname='refresh_discovery_relatives_after_relation' AND NOT tgisinternal",
      "049_discovery_candidate_signals.sql",
    ],
    [
      "SELECT 1 AS present WHERE to_regclass('discovery_linked_pairs') IS NOT NULL AND EXISTS (SELECT 1 FROM pg_trigger WHERE tgrelid=to_regclass('discovery_match_requests') AND tgname='sync_discovery_linked_pair' AND NOT tgisinternal) AND EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema=current_schema() AND table_name='discovery_match_requests' AND column_name='decision_review_token')",
      "050_discovery_match_audit.sql",
    ],
    [
      "SELECT 1 AS present WHERE to_regclass('discovery_linked_pairs') IS NOT NULL AND NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname=current_schema() AND tablename='discovery_match_requests' AND policyname='linked_discovery_read')",
      "051_discovery_linked_request_rls.sql",
    ],
    [
      "SELECT 1 AS present FROM pg_constraint WHERE conrelid=to_regclass('archive_invitations') AND conname='archive_invitations_created_by_fkey' AND confdeltype='c'",
      "040_account_removal_references.sql",
    ],
    [
      "SELECT to_regclass('runtime_visible_person_comments') AS present",
      "041_deleted_account_history.sql",
    ],
    [
      "SELECT 1 AS present FROM pg_trigger WHERE tgrelid=to_regclass('person_comments') AND tgname='guard_deleted_comment_author' AND NOT tgisinternal",
      "052_deleted_account_comments.sql",
    ],
    [
      "SELECT 1 AS present FROM information_schema.columns WHERE table_schema=current_schema() AND table_name='runtime_visible_person_comments' AND column_name='updated_ms'",
      "053_person_comment_edits.sql",
    ],
    [
      "SELECT 1 AS present FROM pg_class c WHERE c.oid=to_regclass('discovery_linked_card_grants') AND c.relforcerowsecurity AND (SELECT count(*) FROM pg_policies WHERE schemaname=current_schema() AND tablename='discovery_linked_card_grants' AND policyname IN ('discovery_linked_card_read','discovery_linked_card_insert','discovery_linked_card_update','discovery_linked_card_delete'))=4",
      "054_discovery_linked_card_grants.sql",
    ],
    [
      "SELECT 1 AS present FROM pg_class c WHERE c.oid=to_regclass('discovery_branch_members') AND c.relforcerowsecurity AND to_regclass('discovery_branch_grants') IS NOT NULL AND EXISTS (SELECT 1 FROM pg_trigger WHERE tgrelid=to_regclass('archives') AND tgname='revoke_discovery_branches_after_edit' AND NOT tgisinternal)",
      "055_discovery_branch_grants.sql",
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
