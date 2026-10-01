import type { ArchiveUser } from "../domain/access.ts";
import { documentSearchText } from "../shared/document-details.ts";
import { accountCapacity } from "./account-capacity.ts";
import { auditStore } from "./audit.ts";
import { ConflictError, type openArchive } from "./database.ts";
import { recordMediaOriginal } from "./media-originals.ts";
import { enforcePostgresMediaQuota } from "./postgres-media-quota.ts";
import type { installPortableOriginals } from "./portable-install.ts";
import { enforceUserStorageLimit } from "./storage-limits.ts";
import { assertCurrentArchiveActor, ForbiddenError } from "./users.ts";
import { sourceCatalogStore } from "./source-catalog-store.ts";

type Installed = Awaited<ReturnType<typeof installPortableOriginals>>;

export async function applyPortablePackage(
  archive: Awaited<ReturnType<typeof openArchive>>,
  actor: ArchiveUser,
  token: string,
  revision: number,
  installed: Installed,
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
  return await archive.write(
    installed.snapshot.family,
    revision,
    undefined,
    undefined,
    undefined,
    undefined,
    async (transaction) => {
      if (transaction.kind === "postgres")
        // Serialize owner revocation with the import commit, without holding
        // a database transaction while originals are copied to disk.
        await transaction.prepare("", "SELECT 1 FROM archive_memberships WHERE user_id=? FOR SHARE")
          .get(actor.id);
      await assertCurrentArchiveActor(transaction, actor);
      if (actor.role !== "admin")
        throw new ForbiddenError("Недостаточно прав для импорта");
      if (transaction.kind === "postgres") {
        const owner = await transaction
          .prepare("", "SELECT 1 FROM archive_owners WHERE user_id=?")
          .get(actor.id);
        if (!owner)
          throw new ForbiddenError("Импорт доступен владельцу дерева");
      }
      const occupied = await transaction
        .prepare(
          "SELECT (SELECT count(*) FROM documents) AS documents,(SELECT count(*) FROM person_comments) AS comments,(SELECT count(*) FROM source_catalog) AS sources",
          "SELECT (SELECT count(*) FROM documents) AS documents,(SELECT count(*) FROM person_comments) AS comments,(SELECT count(*) FROM source_catalog) AS sources",
        )
        .get();
      if (Number(occupied?.documents) || Number(occupied?.comments) || Number(occupied?.sources))
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
          await recordMediaOriginal(transaction, file.url, file.size, actor.id);
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
  );
}
