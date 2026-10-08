import { useEffect, useState, type ReactNode } from "react";
import { archiveFetch } from "../data/archive-fetch.ts";
import { fetchWithTimeout } from "../data/request-timeout.ts";
import { archiveResourceUrl } from "../domain/archive-context.ts";
import { safeUrl, type ArchiveUser, type Person } from "../domain";
import { mediaPreview } from "../domain/media-preview";
import { PortraitImage } from "./portrait-image";

function LinkedPortrait({ personId, fallback }: { personId: string; fallback: ReactNode }) {
  const [photo, setPhoto] = useState<string>();
  useEffect(() => {
    const controller = new AbortController();
    const load = async () => {
      for (let attempt = 0; attempt < 2 && !controller.signal.aborted; attempt++) {
        const response = await fetchWithTimeout("/api/account/portrait", {
          signal: controller.signal, cache: "no-store",
        }, 10_000, archiveFetch);
        if (!response.ok) {
          await response.body?.cancel();
          if (response.status === 409 && attempt === 0) continue;
          return;
        }
        const data = await response.json();
        if (!controller.signal.aborted && data.personId === personId)
          setPhoto(typeof data.photo === "string" ? data.photo : undefined);
        return;
      }
    };
    void load().catch(() => {
      // A denied or unavailable portrait leaves the account initial usable.
    });
    return () => controller.abort();
  }, [personId]);
  return <PortraitImage src={mediaPreview(safeUrl(photo))} loading="eager" fallback={fallback} />;
}

/** Account-only pages resolve just the authenticated member's linked portrait. */
export function AccountPortrait({ user, person, fallback }: {
  user: ArchiveUser | null;
  person?: Person;
  fallback: ReactNode;
}) {
  if (person) return <PortraitImage src={mediaPreview(safeUrl(person.photo))}
    loading="eager" fallback={fallback} />;
  if (!user?.approved || !user.personId) return fallback;
  const key = `${archiveResourceUrl("/api/account/portrait")}:${user.id}:${user.personId}`;
  return <LinkedPortrait key={key} personId={user.personId} fallback={fallback} />;
}
