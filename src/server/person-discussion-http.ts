import type { IncomingMessage, ServerResponse } from "node:http";
import type { openArchive } from "./database.ts";
import type { createAuth } from "./auth.ts";
import { isScopedUser, visiblePersonIds } from "../domain/tree-access.ts";
import { isSameOriginRequest } from "./same-origin.ts";
import { auditStore } from "./audit.ts";
import {
  MAX_COMMENT_LENGTH,
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
};

const sqliteComments = `SELECT c.id,c.person_id,c.author_id,COALESCE(NULLIF(c.author_name,''),u.name) AS author_name,c.created_ms,c.text,c.updated_ms,
  p.id AS author_person_id,json_extract(p.data,'$.surname') AS author_surname,
  json_extract(p.data,'$.name') AS author_given_name,json_extract(p.data,'$.patronymic') AS author_patronymic
  FROM person_comments c LEFT JOIN users u ON u.id=c.author_id LEFT JOIN people p ON p.id=u.person_id`;
const postgresComments = `SELECT c.id,c.person_id,c.author_id,COALESCE(NULLIF(c.author_name,''),u.name) AS author_name,c.created_ms,c.text,c.updated_ms,
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

async function readText(req: IncomingMessage, editing = false) {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 8192) throw new Error("Слишком длинное сообщение");
    chunks.push(chunk);
  }
  const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
  if (!body || typeof body !== "object" || !("text" in body))
    throw new Error("Введите сообщение");
  const text = (body as { text: unknown }).text;
  if (typeof text !== "string") throw new Error("Введите сообщение");
  const value = text.trimEnd();
  if (!value.trim() || value.length > MAX_TEXT)
    throw new Error("Сообщение должно содержать от 1 до 2000 символов");
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
  return { text: value, expectedUpdated };
}

export function personDiscussionHttp({
  archive,
  auth,
  publicOrigin,
}: {
  archive: Awaited<ReturnType<typeof openArchive>>;
  auth: Awaited<ReturnType<typeof createAuth>>;
  publicOrigin?: string;
}) {
  const db = archive.db;
  const audit = auditStore(db);
  const comment = db.prepare(
    `${sqliteComments} WHERE c.id=? AND c.person_id=?`,
    `${postgresComments} WHERE c.id=? AND c.person_id=?`,
  );

  return async (req: IncomingMessage, res: ServerResponse, url: URL) => {
    const match =
      /^\/api\/people\/([^/]+)\/discussion(?:\/([1-9][0-9]*))?$/.exec(
        url.pathname,
      );
    if (!match) return false;
    if (!(await auth.canRead(req)))
      return json(res, 401, { error: "Войдите, чтобы открыть обсуждение" });
    let personId: string;
    try {
      personId = decodeURIComponent(match[1]);
    } catch {
      return json(res, 400, { error: "Некорректный адрес человека" });
    }
    const user = (await auth.currentUser(req))!;
    const visible = isScopedUser(user)
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
      };
    };

    if (req.method === "GET" && !match[2]) {
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

    if (req.method === "POST" && !match[2]) {
      let text: string;
      try {
        ({ text } = await readText(req));
      } catch {
        return json(res, 400, { error: "Введите сообщение до 2000 символов" });
      }
      const now = Date.now();
      const createdRow = await db.transaction(async () => {
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
        const id = Number(
          (
            await db
              .prepare(
                "INSERT INTO person_comments(person_id,author_id,author_name,created_ms,text) VALUES(?,?,?,?,?)",
                "INSERT INTO person_comments(person_id,author_id,author_name,created_ms,text) VALUES(?,?,?,?,?) RETURNING id",
              )
              .run(personId, user.id, user.name, now, text)
          ).lastInsertRowid,
        );
        const row = (await comment.get(id, personId)) as CommentRow;
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
      return json(res, 201, {
        item: present(createdRow),
      });
    }

    if (req.method === "PATCH" && match[2]) {
      const id = Number(match[2]);
      if (!Number.isSafeInteger(id))
        return json(res, 400, { error: "Некорректное сообщение" });
      let edit: Awaited<ReturnType<typeof readText>>;
      try {
        edit = await readText(req, true);
      } catch {
        return json(res, 400, {
          error: "Введите сообщение до 2000 символов и его текущую версию",
        });
      }
      const result = await db.transaction(async () => {
        const row = (await comment.get(id, personId)) as CommentRow | undefined;
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
        if (row.text === edit.text)
          return {
            status: 200,
            item: present(row),
          };
        const updated = Math.max(
          Date.now(),
          row.created_ms + 1,
          (row.updated_ms ?? 0) + 1,
        );
        const changed = await db
          .prepare(
            "UPDATE person_comments SET text=?,updated_ms=? WHERE id=? AND person_id=? AND author_id=? AND updated_ms IS ?",
            "UPDATE person_comments SET text=?,updated_ms=? WHERE id=? AND person_id=? AND author_id=? AND updated_ms IS NOT DISTINCT FROM ?",
          )
          .run(edit.text, updated, id, personId, user.id, edit.expectedUpdated);
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
          item: present({ ...row, text: edit.text, updated_ms: updated }),
        };
      });
      const { status, ...body } = result;
      return json(res, status, body);
    }

    if (req.method === "DELETE" && match[2]) {
      const id = Number(match[2]);
      if (!Number.isSafeInteger(id))
        return json(res, 400, { error: "Некорректное сообщение" });
      const row = (await comment.get(id, personId)) as CommentRow | undefined;
      if (!row) return json(res, 404, { error: "Сообщение не найдено" });
      if (row.author_id !== user.id && user.role !== "admin")
        return json(res, 403, {
          error: "Удалить сообщение может автор или администратор",
        });
      const changed = await db.transaction(async () => {
        const deleted = await db
          .prepare(
            "DELETE FROM person_comments WHERE id=? AND person_id=?",
            "DELETE FROM person_comments WHERE id=? AND person_id=?",
          )
          .run(id, personId);
        if (deleted.changes !== 1) {
          return false;
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

        return true;
      });
      if (!changed) return json(res, 404, { error: "Сообщение не найдено" });
      return json(res, 200, { deleted: true });
    }
    return json(res, 405, { error: "Метод не поддерживается" });
  };
}
