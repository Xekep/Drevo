// Run only as a PostgreSQL administrator after trigger 084 is enabled.
// Each candidate uses a short transaction; provider HTTP remains in the normal worker.
import pg from "pg";
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";

type Candidate = { id: string; archive_id: string; local_chat_id: string };
type Counts = { examined: number; queued: number };

async function assertPrivileged(client: pg.Client) {
  const role = await client.query<{ allowed: boolean }>(`SELECT rolsuper OR rolbypassrls AS allowed
    FROM pg_roles WHERE rolname=current_user`);
  if (!role.rows[0]?.allowed)
    throw new Error("AI cleanup backfill requires a PostgreSQL role that bypasses RLS");
  const trigger = await client.query<{ ready: boolean }>(`SELECT
    current_setting('session_replication_role')='origin' AND EXISTS (
      SELECT 1 FROM pg_trigger WHERE tgrelid=to_regclass('public.ai_chats')
        AND tgname='queue_deleted_ai_chat_conversation' AND tgenabled='O'
        AND tgfoid=to_regprocedure('public.queue_deleted_ai_chat_conversation()')
    ) AS ready`);
  if (!trigger.rows[0]?.ready)
    throw new Error("AI cleanup backfill requires enabled trigger 084 and normal trigger mode");
}

/** Requeue only registered active refs no longer held by their exact local chat. */
export async function backfillAiProviderActiveOrphans(client: pg.Client): Promise<Counts> {
  await assertPrivileged(client);
  const counts = { examined: 0, queued: 0 };
  let cursor = "00000000-0000-0000-0000-000000000000";
  for (;;) {
    await client.query("BEGIN READ ONLY");
    let candidates: pg.QueryResult<Candidate>;
    try {
      await client.query("SET LOCAL row_security=off");
      await client.query("SET LOCAL statement_timeout='15s'");
      candidates = await client.query<Candidate>(`SELECT id,archive_id,local_chat_id
        FROM public.platform_ai_conversations
        WHERE state='active' AND encrypted_snapshot IS NOT NULL AND id>$1::uuid
        ORDER BY id LIMIT 100`, [cursor]);
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK").catch(() => {});
      throw error;
    }
    if (!candidates.rows.length) return counts;
    for (const candidate of candidates.rows) {
      cursor = candidate.id;
      await client.query("BEGIN ISOLATION LEVEL READ COMMITTED");
      try {
        await client.query("SET LOCAL row_security=off");
        await client.query("SET LOCAL lock_timeout='5s'");
        await client.query("SET LOCAL statement_timeout='15s'");
        // bindRegisteredRemote and the 084 DELETE trigger both lock chat first,
        // then ledger. Preserve that order while a concurrent mutation settles.
        const chat = await client.query<{ provider_cleanup_ref: string | null }>(
          `SELECT provider_cleanup_ref FROM public.ai_chats
           WHERE archive_id=$1 AND id=$2 FOR UPDATE`,
          [candidate.archive_id, candidate.local_chat_id],
        );
        const ledger = await client.query<Candidate & { state: string; has_snapshot: boolean }>(
          `SELECT archive_id,local_chat_id,state,
             encrypted_snapshot IS NOT NULL AS has_snapshot
           FROM public.platform_ai_conversations WHERE id=$1 FOR UPDATE`,
          [candidate.id],
        );
        const row = ledger.rows[0];
        if (row?.state === "active" && row.has_snapshot &&
            row.archive_id === candidate.archive_id &&
            row.local_chat_id === candidate.local_chat_id &&
            chat.rows[0]?.provider_cleanup_ref !== candidate.id) {
          const changed = await client.query(`UPDATE public.platform_ai_conversations
            SET state='pending',available_at=(extract(epoch FROM clock_timestamp())*1000)::bigint,
              updated_at=(extract(epoch FROM clock_timestamp())*1000)::bigint,
              lease_token=NULL,lease_until=NULL
            WHERE id=$1 AND state='active'`, [candidate.id]);
          counts.queued += changed.rowCount || 0;
        }
        await client.query("COMMIT");
        counts.examined++;
      } catch (error) {
        await client.query("ROLLBACK").catch(() => {});
        throw error;
      }
    }
  }
}

if (process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) {
  if (process.argv[2] !== "--apply")
    throw new Error("Use --apply for the opt-in registered AI cleanup backfill");
  const client = new pg.Client();
  try {
    await client.connect();
    const counts = await backfillAiProviderActiveOrphans(client);
    console.log(`AI cleanup backfill: examined=${counts.examined}, queued=${counts.queued}`);
  } finally {
    await client.end();
  }
}
