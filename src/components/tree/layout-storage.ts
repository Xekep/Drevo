import type { TreeGeometry } from "../../domain/tree-layout.ts";
import { compatibleLayoutHistory } from "./layout-history.ts";

const DATABASE = "drevo-layout-cache";
const STORE = "layouts";
const MAX_BYTES = 16 * 1024 * 1024;
const MAX_ENTRIES = 24;
const MAX_AGE = 7 * 24 * 60 * 60 * 1000;
type Entry = { id: string; value: string; checksum: string; updated: number; scope?: string; key?: string; projection?: string };
let generation = 0;

async function digest(value: string) {
  const hash = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(value),
  );
  return Array.from(new Uint8Array(hash), (n) =>
    n.toString(16).padStart(2, "0"),
  ).join("");
}

// Storage is optional. Blocked upgrades, quota failures and slow disks must not
// prevent a fresh layout. Close every connection, including late open results.
function access<T>(
  mode: IDBTransactionMode,
  run: (store: IDBObjectStore, result: (value: T) => void) => void,
): Promise<T | undefined> {
  return new Promise((resolve) => {
    let db: IDBDatabase | undefined;
    let transaction: IDBTransaction | undefined;
    let done = false;
    let value: T | undefined;
    const finish = (success: boolean) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      if (!success) {
        try {
          transaction?.abort();
        } catch {
          /* Already completed/aborted. */
        }
      }
      db?.close();
      resolve(success ? value : undefined);
    };
    const timer = setTimeout(
      () => finish(false),
      // Large scene preparation can occupy the main thread while IndexedDB
      // completes. Keep reads bounded, and give background writes time to
      // dispatch their completion instead of aborting an otherwise valid cache.
      mode === "readonly" ? 500 : 5000,
    );
    try {
      const request = indexedDB.open(DATABASE, 1);
      request.onupgradeneeded = () =>
        request.result.createObjectStore(STORE, { keyPath: "id" });
      request.onerror = request.onblocked = () => finish(false);
      request.onsuccess = () => {
        db = request.result;
        if (done) {
          db.close();
          return;
        }
        try {
          transaction = db.transaction(STORE, mode);
          transaction.oncomplete = () => finish(true);
          transaction.onabort = transaction.onerror = () => finish(false);
          run(transaction.objectStore(STORE), (next) => {
            value = next;
          });
        } catch {
          finish(false);
        }
      };
    } catch {
      finish(false);
    }
  });
}

export async function readLayout(
  scope: string,
  key: string,
): Promise<TreeGeometry | undefined> {
  const current = generation;
  try {
    const id = await digest(JSON.stringify([scope, key]));
    const entry = await access<Entry>("readonly", (store, result) => {
      const request = store.get(id);
      request.onsuccess = () => result(request.result);
    });
    if (
      !entry ||
      current !== generation ||
      typeof entry.value !== "string" ||
      entry.value.length * 2 > MAX_BYTES ||
      !Number.isFinite(entry.updated) ||
      Date.now() - entry.updated > MAX_AGE ||
      (await digest(entry.value)) !== entry.checksum
    )
      return;
    const geometry: TreeGeometry = JSON.parse(entry.value);
    if (current !== generation || !Array.isArray(geometry.positions)) return;
    return geometry;
  } catch {
    return;
  }
}

export async function writeLayout(
  scope: string,
  key: string,
  geometry: TreeGeometry,
  projection?: string,
) {
  const current = generation;
  try {
    const value = JSON.stringify(geometry);
    if ((value.length + key.length) * 2 > MAX_BYTES / 2) return;
    const [id, checksum, scopeId] = await Promise.all([
      digest(JSON.stringify([scope, key])),
      digest(value),
      digest(scope),
    ]);
    if (current !== generation) return;
    await access("readwrite", (store) => {
      if (current !== generation) return;
      const request = store.getAll();
      request.onsuccess = () => {
        if (current !== generation) return;
        const entries: Entry[] = request.result.filter(
          (entry: Entry) => entry.id !== id,
        );
        entries.push({ id, value, checksum, updated: Date.now(), scope: scopeId, key, projection });
        entries.sort((a, b) => b.updated - a.updated);
        let bytes = 0;
        let count = 0;
        for (const entry of entries) {
          bytes +=
            typeof entry.value === "string"
              ? (entry.value.length + (entry.key?.length || 0)) * 2
              : MAX_BYTES;
          if (
            ++count > MAX_ENTRIES ||
            bytes > MAX_BYTES ||
            Date.now() - entry.updated > MAX_AGE
          )
            store.delete(entry.id);
          else if (entry.id === id) store.put(entry);
        }
      };
    });
  } catch {
    /* Cache failures never prevent displaying the tree. */
  }
}

/** Reuse nearby revisions after reopening, including edits made by another collaborator. */
export async function readLayoutHistory(scope: string, key: string, projection?: string) {
  const current = generation;
  try {
    const scopeId = await digest(scope);
    const entries = await access<Entry[]>("readonly", (store, result) => {
      const request = store.getAll();
      request.onsuccess = () => result(request.result);
    });
    if (!entries || current !== generation) return;
    for (const entry of entries.sort((a, b) => b.updated - a.updated)) {
      if (entry.scope !== scopeId || (projection !== undefined && entry.projection !== projection) ||
          typeof entry.key !== "string" || entry.key === key ||
          typeof entry.value !== "string" || (entry.value.length + entry.key.length) * 2 > MAX_BYTES / 2 ||
          !Number.isFinite(entry.updated) || Date.now() - entry.updated > MAX_AGE) continue;
      const input = compatibleLayoutHistory(key, entry.key);
      if (!input || await digest(JSON.stringify([scope, entry.key])) !== entry.id ||
          await digest(entry.value) !== entry.checksum) continue;
      const geometry: TreeGeometry = JSON.parse(entry.value);
      if (current !== generation) return;
      if (!Array.isArray(geometry.positions) || geometry.positions.length > 6000 ||
          geometry.mode !== input.mode || geometry.reverse !== input.reverse) continue;
      return { geometry, input };
    }
  } catch {
    // A missing, stale or damaged cache is always a cold calculation.
  }
}

export async function clearLayoutStorage() {
  generation++;
  await access("readwrite", (store) => {
    store.clear();
  });
}
