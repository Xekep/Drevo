import type { StoreDatabase } from "./store-database.ts";
import type { ArchiveUser } from "../domain/access.ts";
import { auditStore } from "./audit.ts";
export type Visibility = {
  publicTree: boolean;
  publicAlbums: boolean;
  reverseTimeline: boolean;
};
export async function settingsStore(db: StoreDatabase) {
  const audit = auditStore(db);
  await db
    .prepare(
      "INSERT OR IGNORE INTO tree_settings VALUES(1,0)",
      "INSERT INTO archive_tree_settings(archive_id,reverse_timeline) VALUES(current_setting('drevo.archive_id', true),false) ON CONFLICT DO NOTHING",
    )
    .run();
  const initial = process.env.ARCHIVE_PRIVATE === "0" ? 1 : 0;
  await db
    .prepare(
      "INSERT OR IGNORE INTO access_settings(id,public_tree,public_albums) VALUES(1,?,?)",
      "INSERT INTO archive_access_settings(archive_id,public_tree,public_albums) VALUES(current_setting('drevo.archive_id', true),?::integer<>0,?::integer<>0) ON CONFLICT DO NOTHING",
    )
    .run(initial, initial);
  async function read(): Promise<Visibility> {
    const row = (await db
      .prepare(
        "SELECT * FROM access_settings WHERE id=1",
        "SELECT * FROM runtime_access_settings WHERE id=1",
      )
      .get())!;
    return {
      publicTree: !!row.public_tree,
      publicAlbums: !!row.public_albums,
      reverseTimeline: !!(await db
        .prepare(
          "SELECT reverse_timeline FROM tree_settings WHERE id=1",
          "SELECT reverse_timeline FROM runtime_tree_settings WHERE id=1",
        )
        .get())!.reverse_timeline,
    };
  }
  return {
    read,
    async write(value: unknown, actor?: ArchiveUser) {
      const v = value as Visibility;
      if (
        !v ||
        typeof v.publicTree !== "boolean" ||
        typeof v.publicAlbums !== "boolean" ||
        (v.reverseTimeline !== undefined &&
          typeof v.reverseTimeline !== "boolean")
      )
        throw new Error("Укажите видимость древа и альбомов");
      const reverse = v.reverseTimeline ?? (await read()).reverseTimeline;
      const before = await read();
      await db.transaction(async () => {
        if (
          (v.publicTree || v.publicAlbums) &&
          (await db
            .prepare(
              "SELECT 1 FROM users WHERE tree_access='common_ancestors' LIMIT 1",
              "SELECT 1 FROM runtime_users WHERE tree_access='common_ancestors' LIMIT 1",
            )
            .get())
        )
          throw new Error(
            "Публичный просмотр недоступен, пока у участников есть ограниченный доступ",
          );
        await db
          .prepare(
            "UPDATE access_settings SET public_tree=?,public_albums=? WHERE id=1",
            "UPDATE archive_access_settings SET public_tree=(?::integer<>0),public_albums=(?::integer<>0)",
          )
          .run(Number(v.publicTree), Number(v.publicAlbums));
        await db
          .prepare(
            "UPDATE tree_settings SET reverse_timeline=? WHERE id=1",
            "UPDATE archive_tree_settings SET reverse_timeline=(?::integer<>0)",
          )
          .run(Number(reverse));
        const after = await read(),
          labels = {
            publicTree: "Публичное древо",
            publicAlbums: "Публичные альбомы",
            reverseTimeline: "Младшие сверху",
          };
        const details = (Object.keys(labels) as (keyof Visibility)[])
          .filter((key) => before[key] !== after[key])
          .map((key) => ({
            field: labels[key],
            before: before[key] ? "Да" : "Нет",
            after: after[key] ? "Да" : "Нет",
          }));
        if (details.length)
          await audit.record(
            {
              action: "Изменены настройки",
              entity: "settings",
              entityId: "archive",
              label: "Настройки архива",
              personIds: [],
              details,
            },
            actor,
          );
      });
      return await read();
    },
  };
}
