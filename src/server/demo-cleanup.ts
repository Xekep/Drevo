import type { openArchive } from "./database.ts";
import { DEMO_IDENTITIES, DEMO_TITLE } from "./demo-ids.ts";

/** Однократное удаление стартового примера, с сохранением добавленных данных. */
export function removeStarterFamily(archive: ReturnType<typeof openArchive>) {
  archive.db.exec(
    "CREATE TABLE IF NOT EXISTS migrations (id TEXT PRIMARY KEY) STRICT",
  );
  const migration = "remove-starter-family-2026-09-v2";
  if (archive.db.prepare("SELECT id FROM migrations WHERE id=?").get(migration))
    return;
  const { family, revision } = archive.read();
  const ids = new Set(
    family.people
      .filter(
        (p) =>
          !p.createdBy &&
          DEMO_IDENTITIES[p.id] ===
            JSON.stringify([p.name, p.surname, p.birth]),
      )
      .map((p) => p.id),
  );
  if (family.demo || ids.size) {
    archive.write(
      {
        ...family,
        demo: false,
        ...(family.title === DEMO_TITLE
          ? { title: "Семейный архив", description: "" }
          : {}),
        people: family.people
          .filter((p) => !ids.has(p.id))
          .map((p) => ({
            ...p,
            parents: p.parents.filter((id) => !ids.has(id)),
            spouses: p.spouses.filter((id) => !ids.has(id)),
            ...(p.parents.some((id) => ids.has(id))
              ? { parentageComplete: false }
              : {}),
          })),
        links: family.links?.filter((l) => !ids.has(l.from) && !ids.has(l.to)),
        photos: family.photos?.map((p) => ({
          ...p,
          tags: p.tags.filter((tag) => !ids.has(tag.personId)),
        })),
      },
      revision,
    );
  }
  archive.db
    .prepare("INSERT OR IGNORE INTO migrations(id) VALUES(?)")
    .run(migration);
}
