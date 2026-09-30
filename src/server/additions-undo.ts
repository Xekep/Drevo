import { archiveChanges } from "../domain/changes.ts";
import {
  removeImportedPeople,
  type ImportBatch,
} from "../domain/additions-undo.ts";
import type { Family } from "../domain/types.ts";
import type { StoreDatabase } from "./store-database.ts";
import { ConflictError } from "./database.ts";

export async function listAdditionBatches(
  db: StoreDatabase,
): Promise<ImportBatch[]> {
  const rows = await db
    .prepare(
      `SELECT a.revision,a.at,a.actor_name,
      (SELECT count(*) FROM audit_entries p WHERE p.revision=a.revision AND p.entity='people' AND p.action='Добавлено') AS count,
      EXISTS(SELECT 1 FROM audit_entries u WHERE u.action='undo_import_additions' AND u.entity_id='import:' || a.revision) AS undone
     FROM audit_entries a WHERE a.action='import_additions' ORDER BY a.id DESC LIMIT 30`,
      `SELECT a.revision,a.at,a.actor_name,
      (SELECT count(*) FROM archive_audit_entries p WHERE p.revision=a.revision AND p.entity='people' AND p.action='Добавлено') AS count,
      EXISTS(SELECT 1 FROM archive_audit_entries u WHERE u.action='undo_import_additions' AND u.entity_id='import:' || a.revision) AS undone
     FROM runtime_visible_audit_entries a WHERE a.action='import_additions' ORDER BY a.id DESC LIMIT 30`,
    )
    .all();
  return rows.map((r) => ({
    revision: Number(r.revision),
    at: String(r.at),
    actorName: String(r.actor_name),
    count: Number(r.count),
    undone: !!r.undone,
  }));
}

export async function planUndoAdditions(
  db: StoreDatabase,
  current: Family,
  revision: unknown,
) {
  if (!Number.isSafeInteger(revision) || Number(revision) < 1)
    throw new Error("Выберите импорт из истории");
  const importRevision = Number(revision);
  const batch = await db
    .prepare(
      "SELECT id FROM audit_entries WHERE action='import_additions' AND revision=?",
      "SELECT id FROM archive_audit_entries WHERE action='import_additions' AND revision=?",
    )
    .get(importRevision);
  if (!batch) throw new Error("Импорт не найден в этом архиве");
  const undone = await db
    .prepare(
      "SELECT id FROM audit_entries WHERE action='undo_import_additions' AND entity_id=?",
      "SELECT id FROM archive_audit_entries WHERE action='undo_import_additions' AND entity_id=?",
    )
    .get(`import:${importRevision}`);
  if (undone) throw new ConflictError("Этот импорт уже отменён");
  const entries = await db
    .prepare(
      `SELECT entity_id,action,revision FROM audit_entries WHERE entity='people' AND revision>=?
     AND entity_id IN (SELECT entity_id FROM audit_entries WHERE revision=? AND entity='people' AND action='Добавлено') ORDER BY id DESC`,
      `SELECT entity_id,action,revision FROM archive_audit_entries WHERE entity='people' AND revision>=?
     AND entity_id IN (SELECT entity_id FROM archive_audit_entries WHERE revision=? AND entity='people' AND action='Добавлено') ORDER BY id DESC`,
    )
    .all(importRevision, importRevision);
  const ids = new Set(
    entries
      .filter(
        (r) =>
          Number(r.revision) === importRevision && r.action === "Добавлено",
      )
      .map((r) => String(r.entity_id)),
  );
  if (!ids.size)
    throw new Error(
      "В журнале нет карточек этого импорта. Автоматическая отмена недоступна",
    );
  const recreated = new Set(
    entries
      .filter(
        (r) => Number(r.revision) > importRevision && r.action === "Добавлено",
      )
      .map((r) => String(r.entity_id)),
  );
  const edited = new Set(
    entries
      .filter(
        (r) => Number(r.revision) > importRevision && r.action === "Изменено",
      )
      .map((r) => String(r.entity_id)),
  );
  const plan = removeImportedPeople(current, ids);
  const errors = [...plan.errors];
  if (plan.people.some((p) => recreated.has(p.id)))
    errors.push(
      "Часть ID была удалена и создана заново после импорта. Автоматическое удаление этих карточек запрещено.",
    );
  if (!plan.people.length)
    errors.push("Все карточки этого импорта уже удалены");
  return {
    family: errors.length ? current : plan.family,
    changes: errors.length ? [] : archiveChanges(current, plan.family),
    preview: {
      importRevision,
      importedCount: ids.size,
      alreadyRemoved: ids.size - plan.people.length,
      editedCount: plan.people.filter((p) => edited.has(p.id)).length,
      people: plan.people,
      connections: plan.connections,
      photoTags: plan.photoTags,
      errors: [...new Set(errors)].slice(0, 100),
      errorCount: errors.length,
    },
  };
}
