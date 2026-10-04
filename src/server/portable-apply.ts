import type { ArchiveUser } from "../domain/access.ts";
import { isArchiveOwner } from "../domain/access.ts";
import { documentSearchText } from "../shared/document-details.ts";
import { accountCapacity } from "./account-capacity.ts";
import {
  AccountSessionExpired,
  assertActiveAccountSession,
} from "./account-session-guard.ts";
import { auditStore } from "./audit.ts";
import { ConflictError, type openArchive } from "./database.ts";
import { recordMediaOriginal } from "./media-originals.ts";
import { enforcePostgresMediaQuota } from "./postgres-media-quota.ts";
import type { installPortableOriginals } from "./portable-install.ts";
import { enforceUserStorageLimit } from "./storage-limits.ts";
import { assertCurrentArchiveActor, ForbiddenError } from "./users.ts";
import { sourceCatalogStore } from "./source-catalog-store.ts";
import type { StoreDatabase } from "./store-database.ts";

type Installed = Awaited<ReturnType<typeof installPortableOriginals>>;

export async function portableStoreOccupied(
  db: StoreDatabase,
): Promise<boolean> {
  const rows = await db
    .prepare(
      "SELECT (SELECT count(*) FROM documents) AS documents,(SELECT count(*) FROM person_comments) AS comments,(SELECT count(*) FROM source_catalog) AS sources",
      "SELECT (SELECT count(*) FROM documents) AS documents,(SELECT count(*) FROM person_comments) AS comments,(SELECT count(*) FROM source_catalog) AS sources",
    )
    .get();
  return Boolean(
    Number(rows?.documents) || Number(rows?.comments) || Number(rows?.sources),
  );
}

export async function applyPortablePackage(
  archive: Awaited<ReturnType<typeof openArchive>>,
  actor: ArchiveUser,
  token: string,
  revision: number,
  installed: Installed,
  session?: { local: boolean; tokenHash?: string },
) {
  const current = await archive.read();
  if (
    current.revision !== revision ||
    current.family.people.length ||
    current.family.photos?.length
  )
    throw new ConflictError(
      "Импорт возможен только в пустое неизменённое дерево",
    );
  const sizes = new Map(installed.copies.map((file) => [file.name, file.size]));
  const documentFiles = new Set(
    installed.snapshot.documents.map((doc) => doc.fileName),
  );
  const assertSession = async (transaction: StoreDatabase) => {
    if (transaction.kind !== "postgres" || session?.local) return;
    if (!session?.tokenHash)
      throw new AccountSessionExpired("Сессия завершена. Войдите снова");
    await assertActiveAccountSession(transaction, actor.id, session.tokenHash);
  };
  return await archive.db.transaction(async () => {
    // Retain the issuing session through the whole import. Files have already
    // been copied outside this transaction and will be undone on denial.
    await assertSession(archive.db);
    const result = await archive.write(
      installed.snapshot.family,
      revision,
      undefined,
      undefined,
      undefined,
      undefined,
      async (transaction) => {
        // This guard retains the membership and owner using NOWAIT, so a
        // concurrent account/access revocation cannot form a lock-order cycle.
        await assertCurrentArchiveActor(transaction, actor);
        if (!isArchiveOwner(actor))
          throw new ForbiddenError("Недостаточно прав для импорта");
        if (transaction.kind === "postgres") {
          const owner = await transaction
            .prepare("", "SELECT 1 FROM archive_owners WHERE user_id=?")
            .get(actor.id);
          if (!owner)
            throw new ForbiddenError("Импорт доступен владельцу дерева");
        }
        if (await portableStoreOccupied(transaction))
          throw new ConflictError("Импорт возможен только в пустое дерево");
        const consumed = await transaction
          .prepare(
            "DELETE FROM workflow_stages WHERE kind='drevo' AND token=? AND actor_id=? AND expires_at>?",
            "DELETE FROM workflow_stages WHERE kind='drevo' AND token=? AND actor_id=? AND expires_at>?",
          )
          .run(token, actor.id, Date.now());
        if (consumed.changes !== 1)
          throw new ConflictError("Предпросмотр импорта использован или истёк");
        const capacity = await accountCapacity(transaction, actor.id);
        if (
          capacity.available &&
          capacity.owned &&
          !capacity.fullAccess &&
          capacity.people > capacity.peopleLimit
        )
          throw new ForbiddenError("Базовый доступ ограничен 150 людьми");
        for (const file of installed.copies) {
          if (!documentFiles.has(file.name))
            await recordMediaOriginal(
              transaction,
              file.url,
              file.size,
              actor.id,
            );
        }
        for (const document of installed.snapshot.documents) {
          const size = sizes.get(document.fileName);
          if (!size) throw new ConflictError("Нет оригинала документа");
          await transaction
            .prepare(
              "INSERT INTO documents(id,title,title_search,file_name,file_size,uploaded_by,created_at,document_type,document_date,place,description,provenance,annotations,event_links,pages) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
              "INSERT INTO documents(id,title,title_search,file_name,file_size,uploaded_by,created_at,document_type,document_date,place,description,provenance,annotations,event_links,pages) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
            )
            .run(
              document.id,
              document.title,
              documentSearchText(document.title, document),
              document.fileName,
              size,
              actor.id,
              document.createdAt,
              document.documentType,
              document.documentDate,
              document.place,
              document.description,
              document.provenance,
              JSON.stringify(document.annotations),
              JSON.stringify(document.eventLinks || []),
              JSON.stringify(document.pages || []),
            );
          for (const personId of document.personIds)
            await transaction
              .prepare(
                "INSERT INTO document_people(document_id,person_id) VALUES(?,?)",
                "INSERT INTO document_people(document_id,person_id) VALUES(?,?)",
              )
              .run(document.id, personId);
        }
        for (const source of installed.snapshot.sources || [])
          await sourceCatalogStore(transaction).insert(source);
        for (const comment of installed.snapshot.comments)
          await transaction
            .prepare(
              "INSERT INTO person_comments(person_id,author_id,author_name,created_ms,text,updated_ms,attachments) VALUES(?,?,?,?,?,?,?)",
              "INSERT INTO person_comments(person_id,author_id,author_name,created_ms,text,updated_ms,attachments) VALUES(?,?,?,?,?,?,?)",
            )
            .run(
              comment.personId,
              comment.authorId,
              comment.authorName,
              comment.createdMs,
              comment.text,
              comment.editedMs ?? null,
              JSON.stringify(comment.attachments || []),
            );
        await enforcePostgresMediaQuota(transaction);
        await enforceUserStorageLimit(transaction, actor.id);
        await auditStore(transaction).record(
          {
            action: "Импортирован архив Drevo",
            entity: "archive",
            entityId: "portable-import",
            label: installed.snapshot.family.title,
            personIds: [],
            details: [],
          },
          actor,
          revision + 1,
        );
      },
      undefined,
      { withinTransaction: true },
    );
    // Expiration can pass while importing many records even though the row is
    // locked. Recheck immediately before the enclosing transaction commits.
    await assertSession(archive.db);
    return result;
  });
}
