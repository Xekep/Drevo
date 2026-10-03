import { DatabaseSync } from "node:sqlite";
import type { CommentAttachmentFile } from "../shared/person-discussion.ts";
import {
  MAX_COMMENT_LENGTH,
  validCommentFiles,
} from "../shared/person-discussion.ts";

const MAX_RESTORE_COMMENTS = 10_000;
const MAX_RESTORE_FILES = 1_000;
const MAX_RESTORE_BYTES = 256 * 1024 * 1024;
const MAX_SOURCE_ID_LENGTH = 512;
const MAX_SOURCE_AUTHOR_NAME_LENGTH = 256;
const MAX_SOURCE_ATTACHMENTS_JSON_LENGTH = 8 * 1024;

export type SourceComment = {
  personId: string;
  authorId: string;
  authorName: string;
  createdMs: number;
  updatedMs: number | null;
  text: string;
  attachments: CommentAttachmentFile[];
};

export function sourceComments(
  source: DatabaseSync,
  people: Set<string>,
): { comments: SourceComment[]; originals: Map<string, number> } {
  if (!source.prepare(
    "SELECT 1 FROM sqlite_schema WHERE type='table' AND name='person_comments'",
  ).get()) return { comments: [], originals: new Map() };
  const count = Number(source.prepare(
    "SELECT count(*) AS count FROM person_comments",
  ).get()!.count);
  if (count > MAX_RESTORE_COMMENTS)
    throw new Error(`В копии больше ${MAX_RESTORE_COMMENTS} комментариев; восстановите их системным способом.`);
  const columns = new Set(source.prepare("PRAGMA table_info(person_comments)")
    .all().map((column) => String(column.name)));
  const select = (name: string, fallback: string) =>
    columns.has(name) ? `c.${name}` : `${fallback} AS ${name}`;
  const hasUsers = Boolean(source.prepare(
    "SELECT 1 FROM sqlite_schema WHERE type='table' AND name='users'",
  ).get());
  const authorName = columns.has("author_name")
    ? `COALESCE(NULLIF(c.author_name,''),${hasUsers ? "u.name" : "NULL"},'Участник архива')`
    : `COALESCE(${hasUsers ? "u.name" : "NULL"},'Участник архива')`;
  const from = `FROM person_comments c ${hasUsers ? "LEFT JOIN users u ON u.id=c.author_id" : ""}`;
  if (source.prepare(`SELECT 1 ${from} WHERE
    length(c.person_id)>${MAX_SOURCE_ID_LENGTH} OR
    length(c.author_id)>${MAX_SOURCE_ID_LENGTH} OR
    length(${authorName})>${MAX_SOURCE_AUTHOR_NAME_LENGTH} OR
    length(c.text)>${MAX_COMMENT_LENGTH} OR
    ${columns.has("attachments") ?
      `length(c.attachments)>${MAX_SOURCE_ATTACHMENTS_JSON_LENGTH}` : "0"}
    LIMIT 1`).get())
    throw new Error("Некорректный комментарий в копии.");
  const rows = source.prepare(`SELECT c.person_id,c.author_id,${authorName} AS author_name,
    c.created_ms,c.text,${select("updated_ms", "NULL")},${select("attachments", "'[]'")}
    ${from}
    ORDER BY c.id`).all();
  const originals = new Map<string, number>();
  const metadata = new Map<string, CommentAttachmentFile>();
  let bytes = 0;
  const comments = rows.map((row): SourceComment => {
    const personId = String(row.person_id);
    const authorId = String(row.author_id);
    const createdMs = Number(row.created_ms);
    const updatedMs = row.updated_ms == null ? null : Number(row.updated_ms);
    const text = String(row.text);
    let attachments: unknown;
    try { attachments = JSON.parse(String(row.attachments || "[]")); }
    catch { throw new Error("Некорректные вложения комментария в копии."); }
    if (!people.has(personId) || !authorId ||
      !Number.isSafeInteger(createdMs) || createdMs < 0 || createdMs > 8.64e15 ||
      (updatedMs !== null && (!Number.isSafeInteger(updatedMs) || updatedMs <= createdMs || updatedMs > 8.64e15)) ||
      text.length > MAX_COMMENT_LENGTH ||
      !validCommentFiles(attachments) ||
      (!text.trim() && attachments.length === 0))
      throw new Error("Некорректный комментарий в копии.");
    for (const file of attachments) {
      const previous = originals.get(file.id);
      const earlier = metadata.get(file.id);
      if (earlier && (earlier.size !== file.size ||
        earlier.name !== file.name || earlier.type !== file.type))
        throw new Error("Противоречивые метаданные вложения в копии.");
      if (previous === undefined) {
        originals.set(file.id, file.size);
        metadata.set(file.id, file);
        bytes += file.size;
      }
      if (originals.size > MAX_RESTORE_FILES || bytes > MAX_RESTORE_BYTES)
        throw new Error("В копии слишком много вложений обсуждений для UI-восстановления.");
    }
    return {
      personId, authorId, authorName: String(row.author_name),
      createdMs, updatedMs, text, attachments,
    };
  });
  return { comments, originals };
}
