import type { DatabaseSync } from "node:sqlite";
export type Visibility = {
  publicTree: boolean;
  publicAlbums: boolean;
  reverseTimeline: boolean;
};
export function settingsStore(db: DatabaseSync) {
  db.exec(
    "CREATE TABLE IF NOT EXISTS access_settings (id INTEGER PRIMARY KEY CHECK(id=1), public_tree INTEGER NOT NULL CHECK(public_tree IN (0,1)), public_albums INTEGER NOT NULL CHECK(public_albums IN (0,1))) STRICT",
  );
  db.exec(
    "CREATE TABLE IF NOT EXISTS tree_settings (id INTEGER PRIMARY KEY CHECK(id=1), reverse_timeline INTEGER NOT NULL DEFAULT 0 CHECK(reverse_timeline IN (0,1))) STRICT; INSERT OR IGNORE INTO tree_settings VALUES(1,0)",
  );
  const initial = process.env.ARCHIVE_PRIVATE === "1" ? 0 : 1;
  db.prepare(
    "INSERT OR IGNORE INTO access_settings(id,public_tree,public_albums) VALUES(1,?,?)",
  ).run(initial, initial);
  function read(): Visibility {
    const row = db.prepare("SELECT * FROM access_settings WHERE id=1").get()!;
    return {
      publicTree: !!row.public_tree,
      publicAlbums: !!row.public_albums,
      reverseTimeline: !!db
        .prepare("SELECT reverse_timeline FROM tree_settings WHERE id=1")
        .get()!.reverse_timeline,
    };
  }
  return {
    read,
    write(value: unknown) {
      const v = value as Visibility;
      if (
        !v ||
        typeof v.publicTree !== "boolean" ||
        typeof v.publicAlbums !== "boolean" ||
        (v.reverseTimeline !== undefined &&
          typeof v.reverseTimeline !== "boolean")
      )
        throw new Error("Укажите видимость древа и альбомов");
      const reverse = v.reverseTimeline ?? read().reverseTimeline;
      db.exec("BEGIN IMMEDIATE");
      try {
        db.prepare(
          "UPDATE access_settings SET public_tree=?,public_albums=? WHERE id=1",
        ).run(Number(v.publicTree), Number(v.publicAlbums));
        db.prepare(
          "UPDATE tree_settings SET reverse_timeline=? WHERE id=1",
        ).run(Number(reverse));
        db.exec("COMMIT");
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
      return read();
    },
  };
}
