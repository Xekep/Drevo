import type { DatabaseSync } from "node:sqlite";
export type Visibility = { publicTree: boolean; publicAlbums: boolean };
export function settingsStore(db: DatabaseSync) {
  db.exec(
    "CREATE TABLE IF NOT EXISTS access_settings (id INTEGER PRIMARY KEY CHECK(id=1), public_tree INTEGER NOT NULL CHECK(public_tree IN (0,1)), public_albums INTEGER NOT NULL CHECK(public_albums IN (0,1))) STRICT",
  );
  const initial = process.env.ARCHIVE_PRIVATE === "1" ? 0 : 1;
  db.prepare("INSERT OR IGNORE INTO access_settings VALUES(1,?,?)").run(
    initial,
    initial,
  );
  function read(): Visibility {
    const row = db.prepare("SELECT * FROM access_settings WHERE id=1").get()!;
    return { publicTree: !!row.public_tree, publicAlbums: !!row.public_albums };
  }
  return {
    read,
    write(value: unknown) {
      const v = value as Visibility;
      if (
        !v ||
        typeof v.publicTree !== "boolean" ||
        typeof v.publicAlbums !== "boolean"
      )
        throw new Error("Укажите видимость древа и альбомов");
      db.prepare(
        "UPDATE access_settings SET public_tree=?,public_albums=? WHERE id=1",
      ).run(Number(v.publicTree), Number(v.publicAlbums));
      return read();
    },
  };
}
