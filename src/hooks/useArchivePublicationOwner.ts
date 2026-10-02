import { useEffect, useState } from "react";
import { archiveFetch } from "../data/archive-fetch.ts";

export type PublicationOwnership = "checking" | "owner" | "other" | "unavailable";

export function useArchivePublicationOwner(userId: string | null, archiveId: string, local: boolean): PublicationOwnership {
  const key = `${userId || ""}\0${archiveId}\0${local}`;
  const [result, setResult] = useState<{ key: string; status: PublicationOwnership }>({
    key: "", status: "checking",
  });

  useEffect(() => {
    if (!userId || local) return;
    const controller = new AbortController();
    void archiveFetch("/api/account/archives", { cache: "no-store", signal: controller.signal })
      .then(async (response) => {
        // The legacy single-archive SQLite deployment has no owner directory.
        if (response.status === 501) return "owner" as const;
        if (!response.ok) throw new Error("Не удалось проверить владельца дерева");
        const data = await response.json() as { archives?: Array<{ current: boolean; owned: boolean }> };
        if (!Array.isArray(data.archives)) throw new Error("Некорректный список деревьев");
        return data.archives.some((item) => item.current && item.owned) ? "owner" as const : "other" as const;
      })
      .then((status) => {
        if (!controller.signal.aborted) setResult({ key, status });
      })
      .catch(() => {
        if (!controller.signal.aborted) setResult({ key, status: "unavailable" });
      });
    return () => controller.abort();
  }, [userId, archiveId, local, key]);

  if (!userId) return "other";
  if (local) return "owner";
  return result.key === key ? result.status : "checking";
}
