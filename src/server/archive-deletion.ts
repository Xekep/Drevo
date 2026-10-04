import type { ArchiveUser } from "../domain/access.ts";
import type { StoreDatabase } from "./store-database.ts";
import { ConflictError } from "./database.ts";
import { assertActiveAccountSession } from "./account-session-guard.ts";
import { assertCurrentArchiveActor, ForbiddenError } from "./users.ts";
import {
  archiveDeletionDirectory,
  markArchiveForDeletion,
  removeDeletedArchiveFiles,
} from "./archive-deletion-files.ts";

type DeletionPlan = {
  title: string;
  people: number;
  photos: number;
  documents: number;
  otherMembers: number;
};

export function archiveDeletion(
  db: StoreDatabase,
  databasePath: string,
  archiveId?: string,
) {
  const available = db.kind === "postgres" && !!archiveId;
  const directory = archiveId
    ? archiveDeletionDirectory(databasePath, archiveId).directory
    : null;

  async function plan(actor: ArchiveUser, lock = false): Promise<DeletionPlan> {
    if (!available) throw new ForbiddenError("Удаление здесь недоступно");
    await assertCurrentArchiveActor(db, actor);
    const row = await db
      .prepare(
        "",
        `SELECT a.title,
          (SELECT count(*) FROM people) AS people,
          (SELECT count(*) FROM photos) AS photos,
          (SELECT count(*) FROM documents) AS documents,
          (SELECT count(*) FROM archive_memberships m
             WHERE m.archive_id=a.id AND m.user_id<>?) AS other_members
         FROM archives a JOIN archive_owners o ON o.archive_id=a.id
         WHERE a.id=current_setting('drevo.archive_id',true) AND o.user_id=?
         ${lock ? "FOR UPDATE OF a,o" : ""}`,
      )
      .get(actor.id, actor.id);
    if (!row)
      throw new ForbiddenError("Удалить древо может только его владелец");
    return {
      title: String(row.title),
      people: Number(row.people),
      photos: Number(row.photos),
      documents: Number(row.documents),
      otherMembers: Number(row.other_members),
    };
  }

  return {
    available,
    plan: async (actor: ArchiveUser) => await plan(actor),
    async remove(
      actor: ArchiveUser,
      confirmation: { title: string; removeCollaborators: boolean },
      sessionTokenHash: string,
    ) {
      if (!available || !archiveId || !directory)
        throw new ForbiddenError("Удаление здесь недоступно");
      const summary = await db.transaction(async () => {
        await assertActiveAccountSession(db, actor.id, sessionTokenHash);
        const current = await plan(actor, true);
        if (confirmation.title !== current.title)
          throw new ConflictError(
            "Название древа не совпало. Проверьте подтверждение",
          );
        if (current.otherMembers && !confirmation.removeCollaborators)
          throw new ConflictError(
            "Подтвердите удаление доступа остальных участников",
          );
        // Mark before the commit: a restart can finish cleanup if the process
        // exits after PostgreSQL commits but before the directory is removed.
        await markArchiveForDeletion(directory, archiveId);
        await db
          .prepare(
            "",
            "DELETE FROM discovery_match_requests WHERE left_archive_id=? OR right_archive_id=?",
          )
          .run(archiveId, archiveId);
        await db
          .prepare("", "DELETE FROM archive_owners WHERE archive_id=?")
          .run(archiveId);
        const deleted = await db
          .prepare("", "DELETE FROM archives WHERE id=?")
          .run(archiveId);
        if (deleted.changes !== 1)
          throw new ConflictError("Древо уже удалено");
        return current;
      });
      let filesRemoved = true;
      try {
        await removeDeletedArchiveFiles(databasePath, archiveId);
      } catch (error) {
        filesRemoved = false;
        console.error("archive_file_cleanup_pending", archiveId, error);
      }
      console.log(
        JSON.stringify({
          level: "info",
          event: "archive_deleted",
          archiveId,
          actorId: actor.id,
          people: summary.people,
          photos: summary.photos,
          documents: summary.documents,
          otherMembers: summary.otherMembers,
          filesRemoved,
        }),
      );
      return { deleted: true, filesRemoved, ...summary };
    },
  };
}
