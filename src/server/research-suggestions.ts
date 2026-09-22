import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { isDeepStrictEqual } from "node:util";
import type { ArchiveUser, Family, Person } from "../domain/index.ts";
import { authorizeArchive } from "./permissions.ts";

const PERSON_UPDATE_FIELDS = [
  "surname",
  "name",
  "patronymic",
  "birth",
  "death",
  "deceased",
  "birthPlace",
  "deathPlace",
  "maidenName",
  "occupation",
  "biography",
  "parentageComplete",
] as const;

type PersonUpdateField = (typeof PERSON_UPDATE_FIELDS)[number];
type PersonChanges = Partial<Pick<Person, PersonUpdateField>>;

export type PersonUpdateSuggestionPayload = {
  personId: string;
  before: PersonChanges;
  changes: PersonChanges;
};

export type ResearchSuggestion = {
  id: string;
  kind: "person_update";
  status: "pending" | "accepted" | "rejected";
  personId: string;
  payload: PersonUpdateSuggestionPayload;
  reason: string;
  evidence: string[];
  baseRevision: number;
  createdAt: string;
  createdBy: string;
  reviewedAt?: string;
  reviewedBy?: string;
};

export const PERSON_UPDATE_PROPOSAL_TOOL = {
  name: "propose_person_update",
  description:
    "Создать предложение изменения карточки человека для ручного подтверждения. Архив не меняется до нажатия человеком «Принять».",
  inputSchema: {
    type: "object",
    properties: {
      personId: { type: "string", minLength: 1, maxLength: 200 },
      changes: {
        type: "object",
        properties: {
          surname: { type: "string", maxLength: 300 },
          name: { type: "string", maxLength: 300 },
          patronymic: { type: "string", maxLength: 300 },
          birth: { type: "string", maxLength: 40 },
          death: { type: "string", maxLength: 40 },
          deceased: { type: "boolean" },
          birthPlace: { type: "string", maxLength: 1000 },
          deathPlace: { type: "string", maxLength: 1000 },
          maidenName: { type: "string", maxLength: 300 },
          occupation: { type: "string", maxLength: 1000 },
          biography: { type: "string", maxLength: 5000 },
          parentageComplete: { type: "boolean" },
        },
        minProperties: 1,
        additionalProperties: false,
      },
      reason: { type: "string", minLength: 1, maxLength: 2000 },
      evidence: {
        type: "array",
        items: { type: "string", minLength: 1, maxLength: 1000 },
        maxItems: 10,
      },
    },
    required: ["personId", "changes", "reason"],
    additionalProperties: false,
  },
} as const;

function personChanges(value: unknown): PersonChanges {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Укажите предлагаемые изменения");
  const raw = value as Record<string, unknown>,
    keys = Object.keys(raw);
  if (!keys.length) throw new Error("Предложение не содержит изменений");
  if (keys.length > PERSON_UPDATE_FIELDS.length)
    throw new Error("Слишком много полей в предложении");
  for (const key of keys)
    if (!PERSON_UPDATE_FIELDS.includes(key as PersonUpdateField))
      throw new Error(`Поле ${key} нельзя менять через предложение ИИ`);

  const result: Record<string, unknown> = {};
  for (const key of keys) {
    const value = raw[key];
    if (key === "deceased" || key === "parentageComplete") {
      if (typeof value !== "boolean")
        throw new Error(`Поле ${key} должно быть логическим`);
    } else if (typeof value !== "string")
      throw new Error(`Поле ${key} должно быть строкой`);
    result[key] = value;
  }
  return result as PersonChanges;
}

function text(value: unknown, label: string, max: number) {
  if (typeof value !== "string" || !value.trim() || value.length > max)
    throw new Error(`Некорректное поле ${label}`);
  return value.trim();
}

function evidence(value: unknown) {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > 10)
    throw new Error("Некорректный список оснований");
  return value.map((item) => text(item, "evidence", 1000));
}

function rowSuggestion(row: Record<string, unknown>): ResearchSuggestion {
  return {
    id: String(row.id),
    kind: "person_update",
    status: String(row.status) as ResearchSuggestion["status"],
    personId: String(row.person_id),
    payload: JSON.parse(String(row.payload)) as PersonUpdateSuggestionPayload,
    reason: String(row.reason),
    evidence: JSON.parse(String(row.evidence)) as string[],
    baseRevision: Number(row.base_revision),
    createdAt: String(row.created_at),
    createdBy: String(row.created_by),
    ...(row.reviewed_at ? { reviewedAt: String(row.reviewed_at) } : {}),
    ...(row.reviewed_by ? { reviewedBy: String(row.reviewed_by) } : {}),
  };
}

export function researchSuggestionStore(db: DatabaseSync) {
  const select = `SELECT id,kind,status,person_id,payload,reason,evidence,base_revision,
      created_at,created_by,reviewed_at,reviewed_by
    FROM research_suggestions`;

  return {
    list(actor: ArchiveUser) {
      const rows =
        actor.role === "admin"
          ? db
              .prepare(`${select} WHERE status='pending' ORDER BY created_at DESC,id DESC`)
              .all()
          : db
              .prepare(
                `${select} WHERE status='pending' AND created_by=? ORDER BY created_at DESC,id DESC`,
              )
              .all(actor.id);
      return rows.map((row) => rowSuggestion(row));
    },

    createPersonUpdate(
      actor: ArchiveUser,
      family: Family,
      revision: number,
      raw: unknown,
    ) {
      if (!raw || typeof raw !== "object" || Array.isArray(raw))
        throw new Error("Некорректное предложение");
      const input = raw as Record<string, unknown>,
        personId = text(input.personId, "personId", 200),
        changes = personChanges(input.changes),
        reason = text(input.reason, "reason", 2000),
        grounds = evidence(input.evidence),
        person = family.people.find((item) => item.id === personId);
      if (!person) throw new Error("Человек не найден или недоступен");

      const before: PersonChanges = {};
      for (const key of Object.keys(changes) as PersonUpdateField[])
        before[key] = person[key] as never;

      const candidate: Family = {
        ...family,
        people: family.people.map((item) =>
          item.id === personId ? ({ ...item, ...changes } as Person) : item,
        ),
      };
      authorizeArchive(candidate, family, actor);
      if (
        (Object.keys(changes) as PersonUpdateField[]).every((key) =>
          isDeepStrictEqual(person[key], changes[key]),
        )
      )
        throw new Error("Предлагаемые значения уже записаны в карточке");

      const id = randomUUID(),
        payload: PersonUpdateSuggestionPayload = {
          personId,
          before,
          changes,
        };
      db.prepare(
        `INSERT INTO research_suggestions
          (id,kind,status,person_id,payload,reason,evidence,base_revision,created_at,created_by)
         VALUES(?,'person_update','pending',?,?,?,?,?,strftime('%Y-%m-%dT%H:%M:%fZ','now'),?)`,
      ).run(
        id,
        personId,
        JSON.stringify(payload),
        reason,
        JSON.stringify(grounds),
        revision,
        actor.id,
      );
      return rowSuggestion(
        db.prepare(`${select} WHERE id=?`).get(id) as Record<string, unknown>,
      );
    },

    get(actor: ArchiveUser, id: string) {
      const row =
        actor.role === "admin"
          ? db.prepare(`${select} WHERE id=?`).get(id)
          : db.prepare(`${select} WHERE id=? AND created_by=?`).get(id, actor.id);
      return row ? rowSuggestion(row as Record<string, unknown>) : null;
    },

    mark(
      actor: ArchiveUser,
      id: string,
      status: "accepted" | "rejected",
    ) {
      const suggestion = this.get(actor, id);
      if (!suggestion) throw new Error("Предложение не найдено");
      if (suggestion.status !== "pending")
        throw new Error("Предложение уже обработано");
      db.prepare(
        `UPDATE research_suggestions
         SET status=?,reviewed_at=strftime('%Y-%m-%dT%H:%M:%fZ','now'),reviewed_by=?
         WHERE id=? AND status='pending'`,
      ).run(status, actor.id, id);
      return this.get(actor, id)!;
    },
  };
}

export function applyPersonUpdateSuggestion(
  family: Family,
  suggestion: ResearchSuggestion,
) {
  const person = family.people.find(
    (item) => item.id === suggestion.payload.personId,
  );
  if (!person) throw new Error("Карточка человека больше не существует");
  for (const key of Object.keys(suggestion.payload.before) as PersonUpdateField[])
    if (!isDeepStrictEqual(person[key], suggestion.payload.before[key]))
      throw new Error(
        "Карточка изменилась после создания предложения. Перепроверьте сведения.",
      );
  return {
    ...family,
    people: family.people.map((item) =>
      item.id === person.id
        ? ({ ...item, ...suggestion.payload.changes } as Person)
        : item,
    ),
  } as Family;
}
