import type { IncomingMessage, ServerResponse } from "node:http";
import type { openArchive } from "./database.ts";
import type { createAuth } from "./auth.ts";
import { isScopedUser, visiblePersonIds } from "../domain/tree-access.ts";
import { isSameOriginRequest } from "./same-origin.ts";
import { auditStore } from "./audit.ts";
import { ForbiddenError } from "./users.ts";
import { statfs } from "node:fs/promises";
import type { mediaStore } from "./media.ts";
import { uploadQuota, UploadQuotaError } from "./upload-quota.ts";
import { enforceUserStorageLimit } from "./storage-limits.ts";
import { enforcePostgresMediaQuota } from "./postgres-media-quota.ts";
import {
  commentFilesFromJson,
  discussionAttachmentStore,
  prepareCommentAttachments,
} from "./discussion-attachments.ts";
import {
  MAX_COMMENT_LENGTH,
  MAX_COMMENT_FILES_BYTES,
  MAX_COMMENT_FILES,
  validCommentFiles,
  type CommentAttachmentFile,
  type PersonComment,
} from "../shared/person-discussion.ts";

const MAX_TEXT = MAX_COMMENT_LENGTH;
const PAGE_SIZE = 20;
type CommentRow = {
  id: number;
  person_id: string;
  author_id: string;
  author_name: string | null;
  author_person_id: string | null;
  author_surname: string | null;
  author_given_name: string | null;
  author_patronymic: string | null;
  created_ms: number;
  updated_ms: number | null;
  text: string;
  attachments: unknown;
};

const sqliteComments = `SELECT c.id,c.person_id,c.author_id,COALESCE(NULLIF(c.author_name,''),u.name) AS author_name,c.created_ms,c.text,c.updated_ms,c.attachments,
  p.id AS author_person_id,json_extract(p.data,'$.surname') AS author_surname,
  json_extract(p.data,'$.name') AS author_given_name,json_extract(p.data,'$.patronymic') AS author_patronymic
  FROM person_comments c LEFT JOIN users u ON u.id=c.author_id LEFT JOIN people p ON p.id=u.person_id`;
const postgresComments = `SELECT c.id,c.person_id,c.author_id,COALESCE(NULLIF(c.author_name,''),u.name) AS author_name,c.created_ms,c.text,c.updated_ms,c.attachments,
  p.id AS author_person_id,p.data->>'surname' AS author_surname,
  p.data->>'name' AS author_given_name,p.data->>'patronymic' AS author_patronymic
  FROM runtime_visible_person_comments c LEFT JOIN runtime_users u ON u.id=c.author_id
  LEFT JOIN people p ON p.archive_id=c.archive_id AND p.id=u.person_id`;

function json(res: ServerResponse, status: number, body: unknown) {
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "private, no-store",
  });
  res.end(JSON.stringify(body));
  return true;
}

async function readText(
  req: IncomingMessage,
  editing = false,
  reserve?: () => Promise<void>,
) {
  const chunks: Buffer[] = [];
  let size = 0;
  let reserved = false;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > Math.ceil(MAX_COMMENT_FILES_BYTES / 3) * 4 + 16_384)
      throw new Error("Слишком длинное сообщение");
    if (size > 8192 && !reserved) {
      await reserve?.();
      reserved = true;
    }
    chunks.push(chunk);
  }
  const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
  if (!body || typeof body !== "object" || !("text" in body))
    throw new Error("Введите сообщение");
  const text = (body as { text: unknown }).text;
  if (typeof text !== "string") throw new Error("Введите сообщение");
  const value = text.trimEnd();
  if (value.length > MAX_TEXT)
    throw new Error("Сообщение должно содержать до 2000 символов");
  let expectedUpdated: number | null = null;
  if (editing) {
    const version = (body as { editedAt?: unknown }).editedAt;
    if (version !== null) {
      if (
        typeof version !== "string" ||
        !Number.isFinite(Date.parse(version)) ||
        new Date(version).toISOString() !== version
      )
        throw new Error("Некорректная версия сообщения");
      expectedUpdated = Date.parse(version);
    }
  }
  return {
    text: value,
    expectedUpdated,
    attachments: await prepareCommentAttachments(
      (body as { attachments?: unknown }).attachments,
    ),
  };
}

export function personDiscussionHttp({
  archive,
  auth,
  publicOrigin,
  uploadsDirectory,
  media,
}: {
  archive: Awaited<ReturnType<typeof openArchive>>;
  auth: Awaited<ReturnType<typeof createAuth>>;
  publicOrigin?: string;
  uploadsDirectory: string;
  media: ReturnType<typeof mediaStore>;
}) {
  const db = archive.db;
  const audit = auditStore(db);
  const attachments = discussionAttachmentStore(uploadsDirectory);
  const quota = uploadQuota(db);
  const comment = db.prepare(
    `${sqliteComments} WHERE c.id=? AND c.person_id=?`,
    `${postgresComments} WHERE c.id=? AND c.person_id=?`,
  );

  return async (req: IncomingMessage, res: ServerResponse, url: URL) => {
    const match =
      /^\/api\/people\/([^/]+)\/discussion(?:\/([1-9][0-9]*)(?:\/attachments\/([a-f0-9-]{36})(\/preview)?)?)?$/.exec(
        url.pathname,
      );
    if (!match) return false;
    const initialUser = await auth.currentUser(req);
    if (!initialUser || !(await auth.canRead(req)))
      return json(res, 401, { error: "Войдите, чтобы открыть обсуждение" });
    let user = initialUser;
    let personId: string;
    try {
      personId = decodeURIComponent(match[1]);
    } catch {
      return json(res, 400, { error: "Некорректный адрес человека" });
    }
    let visible = isScopedUser(user)
      ? visiblePersonIds((await archive.read()).family, user)
      : null;
    const canSee = visible
      ? visible.has(personId)
      : !!(await db
          .prepare(
            "SELECT 1 FROM people WHERE id=?",
            "SELECT 1 FROM people WHERE id=?",
          )
          .get(personId));
    if (!canSee) return json(res, 404, { error: "Человек не найден" });
    const total = async () =>
      Number(
        (
          await db
            .prepare(
              "SELECT count(*) AS total FROM person_comments WHERE person_id=?",
              "SELECT count(*) AS total FROM runtime_visible_person_comments WHERE person_id=?",
            )
            .get(personId)
        )?.total || 0,
      );
    async function checkCurrentAccess() {
      const current = await auth.currentUser(req);
      if (!current || current.id !== user.id || !(await auth.canRead(req)))
        throw new ForbiddenError("Доступ к обсуждению изменился");
      user = current;
      visible = isScopedUser(user)
        ? visiblePersonIds((await archive.read()).family, user)
        : null;
      if (visible && !visible.has(personId))
        throw new ForbiddenError("Доступ к человеку изменился");
    }
    const present = (row: CommentRow): PersonComment => {
      const authorPersonId =
        row.author_person_id && (!visible || visible.has(row.author_person_id))
          ? row.author_person_id
          : null;
      const cardName = authorPersonId
        ? [row.author_surname, row.author_given_name, row.author_patronymic]
            .map((part) => part?.trim())
            .filter(Boolean)
            .join(" ")
        : "";
      return {
        id: row.id,
        text: row.text,
        author:
          cardName ||
          row.author_name ||
          (row.author_id === user.id ? user.name : "Участник архива"),
        authorPersonId,
        createdAt: new Date(row.created_ms).toISOString(),
        editedAt:
          row.updated_ms == null
            ? null
            : new Date(row.updated_ms).toISOString(),
        canDelete: user.role === "admin" || row.author_id === user.id,
        canEdit: row.author_id === user.id,
        attachments: commentFilesFromJson(row.attachments).map((file) => {
          const url = `/api/people/${encodeURIComponent(personId)}/discussion/${row.id}/attachments/${file.id}`;
          return {
            ...file,
            url,
            ...(file.type.startsWith("image/") && {
              previewUrl: `${url}/preview`,
            }),
          };
        }),
      };
    };

    if (req.method === "GET" && match[3]) {
      const row = (await comment.get(Number(match[2]), personId)) as
        CommentRow | undefined;
      const file =
        row &&
        commentFilesFromJson(row.attachments).find(
          (item) => item.id === match[3],
        );
      if (!file || (match[4] && !file.type.startsWith("image/")))
        return json(res, 404, { error: "Вложение не найдено" });
      try {
        const bytes = await attachments.read(file, !!match[4]);
        await checkCurrentAccess();
        const current = (await comment.get(Number(match[2]), personId)) as
          CommentRow | undefined;
        if (!current || !commentFilesFromJson(current.attachments).some(
          (item) => item.id === file.id && item.type === file.type,
        ))
          return json(res, 404, { error: "Вложение не найдено" });
        res.writeHead(200, {
          "Content-Type": match[4] ? "image/webp" : file.type,
          "Content-Length": bytes.length,
          "Cache-Control": "private, no-store",
          "X-Content-Type-Options": "nosniff",
          "Content-Security-Policy": "default-src 'none'; sandbox",
          "Content-Disposition": `${(match[4] || file.type.startsWith("image/")) && url.searchParams.get("download") !== "1" ? "inline" : "attachment"}; filename*=UTF-8''${encodeURIComponent(file.name).replace(/['()*]/g, (character) => `%${character.charCodeAt(0).toString(16)}`)}`,
        });
        res.end(bytes);
        return true;
      } catch {
        return json(res, 404, { error: "Файл вложения не найден" });
      }
    }
    if (match[3]) return json(res, 405, { error: "Метод не поддерживается" });
    if (req.method === "GET" && !match[2]) {
      if (url.searchParams.get("count") === "1")
        return json(res, 200, { total: await total() });
      const rawBefore = url.searchParams.get("before");
      if (rawBefore && !/^[1-9][0-9]*$/.test(rawBefore))
        return json(res, 400, { error: "Некорректная страница" });
      const before = rawBefore ? Number(rawBefore) : Number.MAX_SAFE_INTEGER;
      if (!Number.isSafeInteger(before))
        return json(res, 400, { error: "Некорректная страница" });
      const rows = (await db
        .prepare(
          `${sqliteComments} WHERE c.person_id=? AND c.id<? ORDER BY c.id DESC LIMIT ?`,
          `${postgresComments} WHERE c.person_id=? AND c.id<? ORDER BY c.id DESC LIMIT ?`,
        )
        .all(personId, before, PAGE_SIZE + 1)) as CommentRow[];
      const page = rows.slice(0, PAGE_SIZE);
      return json(res, 200, {
        items: page.map(present),
        nextBefore: rows.length > PAGE_SIZE ? page.at(-1)!.id : null,
        total: await total(),
      });
    }

    if (
      req.method !== "POST" &&
      req.method !== "DELETE" &&
      req.method !== "PATCH"
    )
      return json(res, 405, { error: "Метод не поддерживается" });
    if (!isSameOriginRequest(req, publicOrigin))
      return json(res, 403, { error: "Недопустимый источник запроса" });

    let release: Awaited<ReturnType<typeof quota.acquire>> | undefined;
    let savedFiles: CommentAttachmentFile[] = [];
    async function reserve(
      maximumBytes = MAX_COMMENT_FILES_BYTES + MAX_COMMENT_FILES * 256 * 1024,
    ) {
      if (!release)
        release = await quota.acquire(
          user.id,
          maximumBytes,
          async () => {
            const disk = await statfs(uploadsDirectory);
            return disk.bavail * disk.bsize;
          },
          () => media.usage(true),
        );
    }
    try {
      if (req.method === "POST" && !match[2]) {
        const input = await readText(req, false, reserve);
        const { text } = input;
        if (
          (!text.trim() && !input.attachments?.files.length) ||
          input.attachments?.keep.length
        )
          throw new RangeError("Введите сообщение или прикрепите файл");
        if (input.attachments?.files.length)
          await reserve(
            input.attachments.files.reduce(
              (sum, file) =>
                sum + file.bytes.length + (file.preview?.length || 0),
              0,
            ),
          );
        const now = Date.now();
        const createdRow = await db.transaction(async () => {
          await checkCurrentAccess();
          const recent = (await db
            .prepare(
              "SELECT count(*) AS count FROM audit_entries WHERE actor_id=? AND entity='person_comment' AND action='Добавлено сообщение в обсуждение' AND at>=?",
              "SELECT count(*) AS count FROM archive_audit_entries WHERE actor_id=? AND entity='person_comment' AND action='Добавлено сообщение в обсуждение' AND at>=?",
            )
            .get(user.id, new Date(now - 60_000).toISOString())) as {
            count: number;
          };
          if (recent.count >= 5) {
            return null;
          }
          await release?.assertValid();
          savedFiles = await attachments.save(input.attachments?.files || []);
          const id = Number(
            (
              await db
                .prepare(
                  "INSERT INTO person_comments(person_id,author_id,author_name,created_ms,text,attachments) VALUES(?,?,?,?,?,?)",
                  "INSERT INTO person_comments(person_id,author_id,author_name,created_ms,text,attachments) VALUES(?,?,?,?,?,?) RETURNING id",
                )
                .run(
                  personId,
                  user.id,
                  user.name,
                  now,
                  text,
                  JSON.stringify(savedFiles),
                )
            ).lastInsertRowid,
          );
          const row = (await comment.get(id, personId)) as CommentRow;
          await enforceUserStorageLimit(db, user.id);
          await enforcePostgresMediaQuota(db);
          await audit.record(
            {
              action: "Добавлено сообщение в обсуждение",
              entity: "person_comment",
              entityId: String(id),
              label: "Обсуждение человека",
              personIds: [personId],
              details: [],
            },
            user,
          );

          return row;
        });
        if (!createdRow)
          return json(res, 429, {
            error: "Подождите минуту перед новым сообщением",
          });
        savedFiles = [];
        return json(res, 201, {
          item: present(createdRow),
          total: await total(),
        });
      }

      if (req.method === "PATCH" && match[2]) {
        const id = Number(match[2]);
        if (!Number.isSafeInteger(id))
          return json(res, 400, { error: "Некорректное сообщение" });
        const edit = await readText(req, true, reserve);
        if (edit.attachments?.files.length)
          await reserve(
            edit.attachments.files.reduce(
              (sum, file) =>
                sum + file.bytes.length + (file.preview?.length || 0),
              0,
            ),
          );
        let removed: CommentAttachmentFile[] = [];
        const result = await db.transaction(async () => {
          await checkCurrentAccess();
          const row = (await comment.get(id, personId)) as
            CommentRow | undefined;
          if (!row) return { status: 404, error: "Сообщение не найдено" };
          if (row.author_id !== user.id)
            return {
              status: 403,
              error: "Редактировать сообщение может только его автор",
            };
          if ((row.updated_ms ?? null) !== edit.expectedUpdated)
            return {
              status: 409,
              error:
                "Сообщение уже изменено в другой вкладке. Черновик сохранён; загрузите актуальный текст перед повторной правкой.",
              item: present(row),
            };
          const oldFiles = commentFilesFromJson(row.attachments);
          const kept = edit.attachments
            ? oldFiles.filter((file) =>
                edit.attachments!.keep.includes(file.id),
              )
            : oldFiles;
          if (edit.attachments && kept.length !== edit.attachments.keep.length)
            throw new RangeError("Вложение не принадлежит этому сообщению");
          if (
            !edit.text.trim() &&
            !kept.length &&
            !edit.attachments?.files.length
          )
            throw new RangeError("Введите сообщение или прикрепите файл");
          if (
            row.text === edit.text &&
            kept.length === oldFiles.length &&
            !edit.attachments?.files.length
          )
            return {
              status: 200,
              item: present(row),
            };
          await release?.assertValid();
          savedFiles = await attachments.save(edit.attachments?.files || []);
          const nextFiles = [...kept, ...savedFiles];
          if (!validCommentFiles(nextFiles))
            throw new RangeError("Общий размер вложений — не больше 20 МБ");
          removed = oldFiles.filter(
            (file) => !kept.some((entry) => entry.id === file.id),
          );
          const updated = Math.max(
            Date.now(),
            row.created_ms + 1,
            (row.updated_ms ?? 0) + 1,
          );
          const changed = await db
            .prepare(
              "UPDATE person_comments SET text=?,updated_ms=?,attachments=? WHERE id=? AND person_id=? AND author_id=? AND updated_ms IS ?",
              "UPDATE person_comments SET text=?,updated_ms=?,attachments=? WHERE id=? AND person_id=? AND author_id=? AND updated_ms IS NOT DISTINCT FROM ?",
            )
            .run(
              edit.text,
              updated,
              JSON.stringify(nextFiles),
              id,
              personId,
              user.id,
              edit.expectedUpdated,
            );
          if (changed.changes !== 1) {
            const latest = (await comment.get(id, personId)) as
              CommentRow | undefined;
            return {
              status: 409,
              error: "Сообщение уже изменено или удалено. Черновик сохранён.",
              ...(latest && {
                item: present(latest),
              }),
            };
          }
          if (savedFiles.length) {
            await enforceUserStorageLimit(db, user.id);
            await enforcePostgresMediaQuota(db);
          }
          await audit.record(
            {
              action: "Изменено сообщение в обсуждении",
              entity: "person_comment",
              entityId: String(id),
              label: "Обсуждение человека",
              personIds: [personId],
              details: [],
            },
            user,
          );
          return {
            status: 200,
            item: present({
              ...row,
              text: edit.text,
              updated_ms: updated,
              attachments: nextFiles,
            }),
          };
        });
        const { status, ...body } = result;
        if (status === 200) {
          savedFiles = [];
          await attachments.remove(removed).catch(() => {});
        }
        return json(res, status, body);
      }

      if (req.method === "DELETE" && match[2]) {
        const id = Number(match[2]);
        if (!Number.isSafeInteger(id))
          return json(res, 400, { error: "Некорректное сообщение" });
        let deletedFiles: CommentAttachmentFile[] = [];
        const changed = await db.transaction(async () => {
          await checkCurrentAccess();
          const row = (await comment.get(id, personId)) as
            CommentRow | undefined;
          if (!row) return { status: 404, error: "Сообщение не найдено" };
          if (row.author_id !== user.id && user.role !== "admin")
            return {
              status: 403,
              error: "Удалить сообщение может автор или администратор",
            };
          deletedFiles = commentFilesFromJson(row.attachments);
          const deleted = await db
            .prepare(
              "DELETE FROM person_comments WHERE id=? AND person_id=?",
              "DELETE FROM person_comments WHERE id=? AND person_id=?",
            )
            .run(id, personId);
          if (deleted.changes !== 1) {
            return { status: 404, error: "Сообщение не найдено" };
          }
          await audit.record(
            {
              action: "Удалено сообщение из обсуждения",
              entity: "person_comment",
              entityId: String(id),
              label: "Обсуждение человека",
              personIds: [personId],
              details: [],
            },
            user,
          );

          return { status: 200 };
        });
        if (changed.status !== 200)
          return json(res, changed.status, { error: changed.error });
        await attachments.remove(deletedFiles).catch(() => {});
        return json(res, 200, { deleted: true, total: await total() });
      }
      return json(res, 405, { error: "Метод не поддерживается" });
    } catch (error) {
      return json(
        res,
        error instanceof UploadQuotaError
          ? error.status
          : error instanceof ForbiddenError
            ? 403
            : 400,
        {
          error:
            error instanceof Error
              ? error.message
              : "Не удалось сохранить сообщение",
        },
      );
    } finally {
      if (savedFiles.length)
        await attachments.remove(savedFiles).catch(() => {});
      await release?.();
    }
  };
}
