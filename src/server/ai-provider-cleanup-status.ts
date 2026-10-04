import type { PoolClient } from "pg";
import type {
  AiCleanupFailure,
  AiCleanupFilter,
  AiCleanupJobStatus,
  AiCleanupState,
  AiCleanupStatus,
} from "../shared/ai-provider-cleanup-status.ts";

const states = ["binding", "pending", "leased", "blocked"] as const;
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
type Cursor = { at: number; id: string; filter: AiCleanupFilter };
export class AiCleanupStatusInputError extends Error {}

export function aiCleanupStatusQuery(url: URL) {
  const filter = url.searchParams.get("filter") || "all";
  if (filter !== "all" && filter !== "blocked")
    throw new AiCleanupStatusInputError("Некорректный фильтр очереди");
  const encoded = url.searchParams.get("cursor");
  let cursor: Cursor | null = null;
  if (encoded !== null) {
    try {
      if (!/^[a-zA-Z0-9_-]{1,180}$/.test(encoded)) throw new Error();
      const value = JSON.parse(
        Buffer.from(encoded, "base64url").toString("utf8"),
      );
      if (
        !value ||
        typeof value.id !== "string" ||
        !uuid.test(value.id) ||
        !Number.isSafeInteger(value.at) ||
        value.at < 0 ||
        value.filter !== filter
      )
        throw new Error();
      cursor = { id: value.id, at: value.at, filter };
    } catch {
      throw new AiCleanupStatusInputError("Некорректная страница очереди");
    }
  }
  return { filter, cursor };
}

function safeFailure(value: unknown): {
  error: AiCleanupFailure | null;
  httpStatus?: number;
} {
  if (value === null) return { error: null };
  if (value === "snapshot_invalid" || value === "provider_network")
    return { error: value };
  const match =
    typeof value === "string" &&
    /^provider_(auth|rejected|http)_([45]\d{2})$/.exec(value);
  if (!match) return { error: "unknown" };
  return {
    error:
      match[1] === "auth"
        ? "provider_auth"
        : match[1] === "rejected"
          ? "provider_rejected"
          : "provider_temporary",
    httpStatus: Number(match[2]),
  };
}

/** One SQL snapshot, bounded page, and an explicit public projection. */
export async function aiProviderCleanupStatus(
  client: PoolClient,
  input: ReturnType<typeof aiCleanupStatusQuery>,
): Promise<AiCleanupStatus> {
  const result = await client.query(
    `WITH counts AS (
    SELECT state,count(*) AS total FROM public.platform_ai_conversations
    WHERE state IN ('binding','pending','leased','blocked') GROUP BY state
  ), page AS (
    SELECT id,state,attempts,last_error,available_at,lease_until,updated_at
    FROM public.platform_ai_conversations
    WHERE state IN ('binding','pending','leased','blocked')
      AND ($1::text='all' OR state='blocked')
      AND ($2::bigint IS NULL OR (updated_at,id)<($2::bigint,$3::uuid))
    ORDER BY updated_at DESC,id DESC LIMIT 21
  ) SELECT coalesce((SELECT jsonb_object_agg(state,total) FROM counts),'{}'::jsonb) AS counts,
    coalesce((SELECT jsonb_agg(to_jsonb(p) ORDER BY updated_at DESC,id DESC)
      FROM page p),'[]'::jsonb) AS jobs`,
    [input.filter, input.cursor?.at ?? null, input.cursor?.id ?? null],
  );
  const row = result.rows[0];
  // The archive pool preserves JSON as text for existing stores. Direct pg
  // clients use parsed JSON, so this projection accepts both parser modes.
  const totals = typeof row.counts === "string" ? JSON.parse(row.counts) : row.counts;
  const counts = Object.fromEntries(
    states.map((state) => [state, Number(totals[state] || 0)]),
  ) as Record<AiCleanupState, number>;
  const all = (typeof row.jobs === "string" ? JSON.parse(row.jobs) : row.jobs) as Array<Record<string, unknown>>;
  const selected = all.slice(0, 20);
  const last = selected.at(-1);
  const jobs: AiCleanupJobStatus[] = selected.map((job) => ({
    id: String(job.id),
    state: job.state as AiCleanupState,
    attempts: Number(job.attempts),
    updatedAt: Number(job.updated_at),
    nextAttemptAt:
      job.state === "blocked"
        ? null
        : Number(
            job.state === "leased"
              ? (job.lease_until ?? job.available_at)
              : job.available_at,
          ),
    ...safeFailure(job.last_error),
  }));
  return {
    supported: true,
    checkedAt: Date.now(),
    counts,
    jobs,
    nextCursor:
      all.length > 20 && last
        ? Buffer.from(
            JSON.stringify({
              at: Number(last.updated_at),
              id: String(last.id),
              filter: input.filter,
            }),
          ).toString("base64url")
        : null,
  };
}
