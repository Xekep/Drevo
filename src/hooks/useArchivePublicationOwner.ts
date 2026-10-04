import { useEffect, useState } from "react";
import { archiveFetch } from "../data/archive-fetch.ts";

export type PublicationOwnership = "checking" | "owner" | "other" | "unavailable";

export function useArchivePublicationOwner(
  userId: string | null,
  archiveId: string,
  local: boolean,
  ready: boolean,
): PublicationOwnership {
  const key = `${userId || ""}\0${archiveId}\0${local}\0${ready}`;
  const [result, setResult] = useState<{ key: string; status: PublicationOwnership }>({
    key: "", status: "checking",
  });

  useEffect(() => {
    if (!userId || !ready || local) return;
    const controller = new AbortController();
    void archiveFetch("/api/account/archives", { cache: "no-store", signal: controller.signal })
      .then(async (response) => {
        // The legacy single-archive SQLite deployment has no owner directory.
        if (response.status === 501) return "owner" as const;
        if (!response.ok) throw new Error("Не удалось проверить владельца древа");
        const data = await response.json() as { archives?: Array<{ current: boolean; owned: boolean }> };
        if (!Array.isArray(data.archives)) throw new Error("Некорректный список древ");
        return data.archives.some((item) => item.current && item.owned) ? "owner" as const : "other" as const;
      })
      .then((status) => {
        if (!controller.signal.aborted) setResult({ key, status });
      })
      .catch(() => {
        if (!controller.signal.aborted) setResult({ key, status: "unavailable" });
      });
    return () => controller.abort();
  }, [userId, archiveId, local, ready, key]);

  if (!userId) return "other";
  if (!ready) return "checking";
  if (local) return "owner";
  return result.key === key ? result.status : "checking";
}
