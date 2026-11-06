import { archiveFetch } from "../../data/archive-fetch.ts";
import { memberPreviewAt } from "../../domain/archive-context.ts";
import {
  LAYOUT_CACHE_VERSION,
  SHARED_LAYOUT_MAX_PEOPLE,
  type LayoutCacheInput,
} from "../../domain/layout-cache-key.ts";
import type { TreeGeometry } from "../../domain/tree-layout.ts";

/** Optional shared cold result. A miss, offline server or old release never blocks the local Worker. */
export async function readSharedLayout(
  input: LayoutCacheInput,
  key: string,
  signal: AbortSignal,
): Promise<TreeGeometry | null> {
  if (
    // Participant preview permits GET only; its geometry stays local.
    (typeof window !== "undefined" && memberPreviewAt(window.location.pathname)) ||
    input.mode !== "generations" ||
    input.people.length < 2 ||
    input.people.length > SHARED_LAYOUT_MAX_PEOPLE
  )
    return null;
  const timeout = new AbortController(),
    timer = setTimeout(() => timeout.abort(), 5000);
  try {
    const bytes = await crypto.subtle.digest(
      "SHA-256",
      new TextEncoder().encode(key),
    );
    const hash = [...new Uint8Array(bytes)]
      .map((n) => n.toString(16).padStart(2, "0"))
      .join("");
    const response = await archiveFetch("/api/tree-layout", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      signal: AbortSignal.any([signal, timeout.signal]),
      body: JSON.stringify({
        hash,
        version: LAYOUT_CACHE_VERSION,
        reverse: input.reverse,
        people: input.people.map((p) => p.id),
      }),
    });
    if (!response.ok) return null;
    const data = await response.json();
    if (
      data.hash !== hash ||
      !data.geometry ||
      data.geometry.mode !== input.mode ||
      data.geometry.reverse !== input.reverse ||
      !Array.isArray(data.geometry.positions)
    )
      return null;
    return data.geometry as TreeGeometry;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}
