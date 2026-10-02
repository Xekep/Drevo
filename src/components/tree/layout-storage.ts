import type { TreeGeometry } from "../../domain/tree-layout.ts";

const DATABASE = "drevo-layout-cache";
const STORE = "layouts";
const MAX_BYTES = 16 * 1024 * 1024;
const MAX_ENTRIES = 24;
const MAX_AGE = 7 * 24 * 60 * 60 * 1000;
type Entry = { id: string; value: string; checksum: string; updated: number };
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
) {
  const current = generation;
  try {
    const value = JSON.stringify(geometry);
    if (value.length * 2 > MAX_BYTES / 2) return;
    const [id, checksum] = await Promise.all([
      digest(JSON.stringify([scope, key])),
      digest(value),
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
        entries.push({ id, value, checksum, updated: Date.now() });
        entries.sort((a, b) => b.updated - a.updated);
        let bytes = 0;
        let count = 0;
        for (const entry of entries) {
          bytes +=
            typeof entry.value === "string"
              ? entry.value.length * 2
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

export async function clearLayoutStorage() {
  generation++;
  await access("readwrite", (store) => {
    store.clear();
  });
}
