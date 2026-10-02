import type { StoreDatabase } from "./store-database.ts";

export type AiOrphanSweepResult = { removed: number; errors: number };

/** Background maintenance for AI files in archives with no open HTTP route. */
export async function sweepPlatformAiOrphans(
  _db: StoreDatabase,
  _databasePath: string,
  _options: {
    now?: number;
    onError?: (archiveId: string, error: unknown) => void;
  } = {},
): Promise<AiOrphanSweepResult> {
  void _options;
  return { removed: 0, errors: 0 };
}
