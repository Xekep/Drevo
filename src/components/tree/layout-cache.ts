import type { TreeGeometry } from "../../domain/tree-layout.ts";
import {
  treeNodeSize,
  TREE_NODE_WIDTH,
} from "../../domain/tree-layout-constants.ts";
import type { LayoutWorkerRequest } from "./layout-worker-protocol.ts";

// Bump when layout, packing or routing changes. Keep model order: ELK uses it.
export const LAYOUT_CACHE_VERSION = 10;
export function layoutCacheKey(input: Omit<LayoutWorkerRequest, "requestId" | "previousGeometry">) {
  return JSON.stringify({
    version: LAYOUT_CACHE_VERSION,
    width: TREE_NODE_WIDTH,
    height: treeNodeSize().height,
    input,
  });
}

export function createLayoutMemoryCache(
  maxEntries = 12,
  maxBytes = 8 * 1024 * 1024,
) {
  const entries = new Map<string, { geometry: TreeGeometry; bytes: number }>();
  let bytes = 0;
  return {
    get(key: string) {
      const entry = entries.get(key);
      if (!entry) return;
      entries.delete(key);
      entries.set(key, entry);
      return entry.geometry;
    },
    set(key: string, geometry: TreeGeometry) {
      const size = 2 * (key.length + JSON.stringify(geometry).length);
      const previous = entries.get(key);
      if (previous) bytes -= previous.bytes;
      entries.delete(key);
      if (size > maxBytes || maxEntries < 1) return;
      entries.set(key, { geometry, bytes: size });
      bytes += size;
      while (entries.size > maxEntries || bytes > maxBytes) {
        const oldest = entries.keys().next().value!;
        bytes -= entries.get(oldest)!.bytes;
        entries.delete(oldest);
      }
    },
  };
}
