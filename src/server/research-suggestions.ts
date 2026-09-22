import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { isDeepStrictEqual } from "node:util";
import {
  EXTRA_LINK_TYPES,
  type ArchiveUser,
  type Family,
  type FamilyLink,
  type Person,
  type Source,
} from "../domain/index.ts";
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
type SuggestionStatus = "pending" | "accepted" | "rejected";

export type PersonUpdateSuggestionPayload = {
  personId: string;
  before: PersonChanges;
  changes: PersonChanges;
};

export type PersonCreateSuggestionPayload = {
  person: Person;
};

export type SourceSuggestionPayload = {
  personId: string;
  beforeSources: Source[];
  source: Source;
};

export type SuggestedRelationType =
  | "parent"
  | "spouse"
  | FamilyLink["type"];

type RelationBefore =
  | { mode: "parent"; toParents: string[] }
  | { mode: "spouse"; fromSpouses: string[]; toSpouses: string[] }
  | { mode: "extra"; links: FamilyLink[] };

export type RelationSuggestionPayload = {
  fromPersonId: string;
  toPersonId: string;
  relationType: SuggestedRelationType;
  note?: string;
  linkId?: string;
  before: RelationBefore;
};

type SuggestionBase = {
  id: string;
  status: SuggestionStatus;
  personId: string;
  reason: string;
  evidence: string[];
  baseRevision: number;
  createdAt: string;
  createdBy: string;
  reviewedAt?: string;
  reviewedBy?: string;
};

export type ResearchSuggestion =
  | (SuggestionBase & {
      kind: "person_create";
      payload: PersonCreateSuggestionPayload;
    })
  | (SuggestionBase & {
      kind: "person_update";
      payload: PersonUpdateSuggestionPayload;
    })
  | (SuggestionBase & {
      kind: "source";
      payload: SourceSuggestionPayload;
    })
  | (SuggestionBase & {
      kind: "relation";
      payload: RelationSuggestionPayload;
    });

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

export const PERSON_CREATE_PROPOSAL_TOOL = {
  name: "propose_person_create",
  description:
    "Создать предложение новой карточки человека для ручного подтверждения. Карточка появится в архиве только после нажатия человеком «Принять».",
  inputSchema: {
    type: "object",
    properties: {
      person: {
        type: "object",
        properties: {
          surname: { type: "string", minLength: 1, maxLength: 300 },
          name: { type: "string", minLength: 1, maxLength: 300 },
          patronymic: { type: "string", maxLength: 300 },
          sex: { type: "string", enum: ["m", "f", "u"] },
          birth: { type: "string", maxLength: 40 },
          birthPlace: { type: "string", maxLength: 1000 },
          occupation: { type: "string", maxLength: 1000 },
          biography: { type: "string", maxLength: 5000 },
        },
        required: ["surname", "name"],
        additionalProperties: false,
      },
      reason: { type: "string", minLength: 1, maxLength: 2000 },
      evidence: {
        type: "array",
        items: { type: "string", minLength: 1, maxLength: 1000 },
        maxItems: 10,
      },
    },
    required: ["person", "reason"],
    additionalProperties: false,
  },
} as const;

export const SOURCE_PROPOSAL_TOOL = {
  name: "propose_source",
  description:
    "Предложить добавить источник к карточке человека. Источник сохраняется только после ручного подтверждения.",
  inputSchema: {
    type: "object",
    properties: {
      personId: { type: "string", minLength: 1, maxLength: 200 },
      source: {
        type: "object",
        properties: {
          title: { type: "string", minLength: 1, maxLength: 1000 },
          type: { type: "string", minLength: 1, maxLength: 200 },
          reference: { type: "string", minLength: 1, maxLength: 2000 },
          url: { type: "string", maxLength: 2048 },
          note: { type: "string", maxLength: 4000 },
        },
        required: ["title", "type", "reference"],
        additionalProperties: false,
      },
      reason: { type: "string", minLength: 1, maxLength: 2000 },
      evidence: {
        type: "array",
        items: { type: "string", minLength: 1, maxLength: 1000 },
        maxItems: 10,
      },
    },
    required: ["personId", "source", "reason"],
    additionalProperties: false,
  },
} as const;

export const RELATION_PROPOSAL_TOOL = {
  name: "propose_relation",
  description:
    "Предложить родственную или дополнительную связь между двумя существующими людьми. Связь создаётся только после ручного подтверждения.",
  inputSchema: {
    type: "object",
    properties: {
      fromPersonId: { type: "string", minLength: 1, maxLength: 200 },
      toPersonId: { type: "string", minLength: 1, maxLength: 200 },
      relationType: {
        type: "string",
        enum: [
          "parent",
          "spouse",
          "adoptive_parent",
          "step_parent",
          "godparent",
          "nurse",
          "sworn_sibling",
          "guardian",
        ],
      },
      note: { type: "string", maxLength: 2000 },
      reason: { type: "string", minLength: 1, maxLength: 2000 },
      evidence: {
        type: "array",
        items: { type: "string", minLength: 1, maxLength: 1000 },
        maxItems: 10,
      },
    },
    required: ["fromPersonId", "toPersonId", "relationType", "reason"],
    additionalProperties: false,
  },
} as const;

export const RESEARCH_PROPOSAL_TOOLS = [
  PERSON_CREATE_PROPOSAL_TOOL,
  PERSON_UPDATE_PROPOSAL_TOOL,
  SOURCE_PROPOSAL_TOOL,
  RELATION_PROPOSAL_TOOL,
] as const;

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
    const fieldValue = raw[key];
    if (key === "deceased" || key === "parentageComplete") {
      if (typeof fieldValue !== "boolean")
        throw new Error(`Поле ${key} должно быть логическим`);
    } else if (typeof fieldValue !== "string")
      throw new Error(`Поле ${key} должно быть строкой`);
    result[key] = fieldValue;
  }
  return result as PersonChanges;
}

function proposedPerson(value: unknown, actor: ArchiveUser): Person {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Укажите данные нового человека");
  const raw = value as Record<string, unknown>,
    sex = raw.sex === undefined ? "u" : raw.sex;
  if (sex !== "m" && sex !== "f" && sex !== "u")
    throw new Error("Некорректно указан пол");
  return {
    id: randomUUID(),
    createdBy: actor.id,
    surname: text(raw.surname, "person.surname", 300),
    name: text(raw.name, "person.name", 300),
    patronymic: optionalText(raw.patronymic, "person.patronymic", 300) || "",
    sex,
    birth: optionalText(raw.birth, "person.birth", 40) || "",
    birthPlace:
      optionalText(raw.birthPlace, "person.birthPlace", 1000) || "",
    ...(optionalText(raw.occupation, "person.occupation", 1000)
      ? { occupation: optionalText(raw.occupation, "person.occupation", 1000) }
      : {}),
    ...(optionalText(raw.biography, "person.biography", 5000)
      ? { biography: optionalText(raw.biography, "person.biography", 5000) }
      : {}),
    parents: [],
    spouses: [],
    generation: 1,
    column: 0,
    sources: [],
  };
}

function text(value: unknown, label: string, max: number) {
  if (typeof value !== "string" || !value.trim() || value.length > max)
    throw new Error(`Некорректное поле ${label}`);
  return value.trim();
}

function optionalText(value: unknown, label: string, max: number) {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || value.length > max)
    throw new Error(`Некорректное поле ${label}`);
  const trimmed = value.trim();
  return trimmed || undefined;
}

function evidence(value: unknown) {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > 10)
    throw new Error("Некорректный список оснований");
  return value.map((item) => text(item, "evidence", 1000));
}

function sourceValue(value: unknown): Source {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Укажите источник");
  const raw = value as Record<string, unknown>,
    result: Source = {
      title: text(raw.title, "source.title", 1000),
      type: text(raw.type, "source.type", 200),
      reference: text(raw.reference, "source.reference", 2000),
    },
    url = optionalText(raw.url, "source.url", 2048),
    note = optionalText(raw.note, "source.note", 4000);
  if (url) {
    if (!/^https?:\/\/[^\s]+$/i.test(url))
      throw new Error("Ссылка источника должна использовать HTTP/HTTPS");
    result.url = url;
  }
  if (note) result.note = note;
  return result;
}

function relationType(value: unknown): SuggestedRelationType {
  if (value === "parent" || value === "spouse") return value;
  if (
    typeof value === "string" &&
    EXTRA_LINK_TYPES.includes(value as FamilyLink["type"])
  )
    return value as FamilyLink["type"];
  throw new Error("Неизвестный тип связи");
}

function rowSuggestion(row: Record<string, unknown>): ResearchSuggestion {
  const kind = String(row.kind) as ResearchSuggestion["kind"],
    base = {
      id: String(row.id),
      status: String(row.status) as SuggestionStatus,
      personId: String(row.person_id),
      reason: String(row.reason),
      evidence: JSON.parse(String(row.evidence)) as string[],
      baseRevision: Number(row.base_revision),
      createdAt: String(row.created_at),
      createdBy: String(row.created_by),
      ...(row.reviewed_at ? { reviewedAt: String(row.reviewed_at) } : {}),
      ...(row.reviewed_by ? { reviewedBy: String(row.reviewed_by) } : {}),
    };
  const payload = JSON.parse(String(row.payload)) as unknown;
  if (kind === "person_create")
    return {
      ...base,
      kind,
      payload: payload as PersonCreateSuggestionPayload,
    };
  if (kind === "person_update")
    return {
      ...base,
      kind,
      payload: payload as PersonUpdateSuggestionPayload,
    };
  if (kind === "source")
    return { ...base, kind, payload: payload as SourceSuggestionPayload };
  if (kind === "relation")
    return { ...base, kind, payload: payload as RelationSuggestionPayload };
  throw new Error("Неизвестный тип исследовательского предложения");
}

function extraRelationMatches(
  link: FamilyLink,
  payload: Pick<
    RelationSuggestionPayload,
    "fromPersonId" | "toPersonId" | "relationType"
  >,
) {
  if (link.type !== payload.relationType) return false;
  if (payload.relationType === "sworn_sibling")
    return (
      (link.from === payload.fromPersonId && link.to === payload.toPersonId) ||
      (link.from === payload.toPersonId && link.to === payload.fromPersonId)
    );
  return (
    link.from === payload.fromPersonId && link.to === payload.toPersonId
  );
}

function relationBefore(
  family: Family,
  fromPersonId: string,
  toPersonId: string,
  type: SuggestedRelationType,
): RelationBefore {
  const from = family.people.find((person) => person.id === fromPersonId),
    to = family.people.find((person) => person.id === toPersonId);
  if (!from || !to) throw new Error("Один из участников связи не найден");
  if (from.id === to.id) throw new Error("Нельзя связать человека с самим собой");
  if (type === "parent")
    return { mode: "parent", toParents: [...to.parents] };
  if (type === "spouse")
    return {
      mode: "spouse",
      fromSpouses: [...from.spouses],
      toSpouses: [...to.spouses],
    };
  return {
    mode: "extra",
    links: (family.links || []).filter((link) =>
      extraRelationMatches(link, {
        fromPersonId,
        toPersonId,
        relationType: type,
      }),
    ),
  };
}

function withRelation(
  family: Family,
  payload: Omit<RelationSuggestionPayload, "before">,
) {
  const { fromPersonId, toPersonId, relationType: type } = payload,
    from = family.people.find((person) => person.id === fromPersonId),
    to = family.people.find((person) => person.id === toPersonId);
  if (!from || !to) throw new Error("Один из участников связи не найден");
  if (from.id === to.id) throw new Error("Нельзя связать человека с самим собой");

  if (type === "parent") {
    if (to.parents.includes(from.id))
      throw new Error("Такая родительская связь уже записана");
    return {
      ...family,
      people: family.people.map((person) =>
        person.id === to.id
          ? { ...person, parents: [...person.parents, from.id] }
          : person,
      ),
    } as Family;
  }

  if (type === "spouse") {
    if (from.spouses.includes(to.id) || to.spouses.includes(from.id))
      throw new Error("Такая супружеская связь уже записана");
    return {
      ...family,
      people: family.people.map((person) =>
        person.id === from.id
          ? { ...person, spouses: [...person.spouses, to.id] }
          : person.id === to.id
            ? { ...person, spouses: [...person.spouses, from.id] }
            : person,
      ),
    } as Family;
  }

  const proposed: FamilyLink = {
    id: payload.linkId || randomUUID(),
    from: from.id,
    to: to.id,
    type,
    ...(payload.note ? { note: payload.note } : {}),
  };
  if (
    (family.links || []).some((link) =>
      extraRelationMatches(link, {
        fromPersonId,
        toPersonId,
        relationType: type,
      }),
    )
  )
    throw new Error("Такая дополнительная связь уже записана");
  return {
    ...family,
    links: [...(family.links || []), proposed],
  };
}

export function researchSuggestionStore(db: DatabaseSync) {
  const select = `SELECT id,kind,status,person_id,payload,reason,evidence,base_revision,
      created_at,created_by,reviewed_at,reviewed_by
    FROM research_suggestions`;

  const insert = (
    actor: ArchiveUser,
    kind: ResearchSuggestion["kind"],
    personId: string,
    payload:
      | PersonCreateSuggestionPayload
      | PersonUpdateSuggestionPayload
      | SourceSuggestionPayload
      | RelationSuggestionPayload,
    reason: string,
    grounds: string[],
    revision: number,
  ) => {
    const id = randomUUID();
    db.prepare(
      `INSERT INTO research_suggestions
        (id,kind,status,person_id,payload,reason,evidence,base_revision,created_at,created_by)
       VALUES(?,?,'pending',?,?,?,?,?,strftime('%Y-%m-%dT%H:%M:%fZ','now'),?)`,
    ).run(
      id,
      kind,
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
  };

  return {
    list(actor: ArchiveUser) {
      const rows =
        actor.role === "admin"
          ? db
              .prepare(
                `${select} WHERE status='pending' ORDER BY created_at DESC,id DESC`,
              )
              .all()
          : db
              .prepare(
                `${select} WHERE status='pending' AND created_by=? ORDER BY created_at DESC,id DESC`,
              )
              .all(actor.id);
      return rows.map((row) => rowSuggestion(row));
    },

    createPerson(
      actor: ArchiveUser,
      family: Family,
      revision: number,
      raw: unknown,
    ) {
      if (!raw || typeof raw !== "object" || Array.isArray(raw))
        throw new Error("Некорректное предложение");
      const input = raw as Record<string, unknown>,
        person = proposedPerson(input.person, actor),
        reason = text(input.reason, "reason", 2000),
        grounds = evidence(input.evidence),
        candidate: Family = { ...family, people: [...family.people, person] };
      authorizeArchive(candidate, family, actor);
      return insert(
        actor,
        "person_create",
        person.id,
        { person },
        reason,
        grounds,
        revision,
      );
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

      return insert(
        actor,
        "person_update",
        personId,
        { personId, before, changes },
        reason,
        grounds,
        revision,
      );
    },

    createSource(
      actor: ArchiveUser,
      family: Family,
      revision: number,
      raw: unknown,
    ) {
      if (!raw || typeof raw !== "object" || Array.isArray(raw))
        throw new Error("Некорректное предложение");
      const input = raw as Record<string, unknown>,
        personId = text(input.personId, "personId", 200),
        source = sourceValue(input.source),
        reason = text(input.reason, "reason", 2000),
        grounds = evidence(input.evidence),
        person = family.people.find((item) => item.id === personId);
      if (!person) throw new Error("Человек не найден или недоступен");
      if (person.sources.some((item) => isDeepStrictEqual(item, source)))
        throw new Error("Такой источник уже записан");

      const candidate: Family = {
        ...family,
        people: family.people.map((item) =>
          item.id === person.id
            ? { ...item, sources: [...item.sources, source] }
            : item,
        ),
      };
      authorizeArchive(candidate, family, actor);
      return insert(
        actor,
        "source",
        personId,
        {
          personId,
          beforeSources: structuredClone(person.sources),
          source,
        },
        reason,
        grounds,
        revision,
      );
    },

    createRelation(
      actor: ArchiveUser,
      family: Family,
      revision: number,
      raw: unknown,
    ) {
      if (!raw || typeof raw !== "object" || Array.isArray(raw))
        throw new Error("Некорректное предложение");
      const input = raw as Record<string, unknown>,
        fromPersonId = text(input.fromPersonId, "fromPersonId", 200),
        toPersonId = text(input.toPersonId, "toPersonId", 200),
        type = relationType(input.relationType),
        note = optionalText(input.note, "note", 2000),
        reason = text(input.reason, "reason", 2000),
        grounds = evidence(input.evidence),
        before = relationBefore(family, fromPersonId, toPersonId, type),
        linkId =
          type === "parent" || type === "spouse" ? undefined : randomUUID(),
        payload: RelationSuggestionPayload = {
          fromPersonId,
          toPersonId,
          relationType: type,
          ...(note ? { note } : {}),
          ...(linkId ? { linkId } : {}),
          before,
        };
      authorizeArchive(withRelation(family, payload), family, actor);
      return insert(
        actor,
        "relation",
        fromPersonId,
        payload,
        reason,
        grounds,
        revision,
      );
    },

    createFromTool(
      name: string,
      actor: ArchiveUser,
      family: Family,
      revision: number,
      raw: unknown,
    ) {
      if (name === PERSON_CREATE_PROPOSAL_TOOL.name)
        return this.createPerson(actor, family, revision, raw);
      if (name === PERSON_UPDATE_PROPOSAL_TOOL.name)
        return this.createPersonUpdate(actor, family, revision, raw);
      if (name === SOURCE_PROPOSAL_TOOL.name)
        return this.createSource(actor, family, revision, raw);
      if (name === RELATION_PROPOSAL_TOOL.name)
        return this.createRelation(actor, family, revision, raw);
      throw new Error("Неизвестный инструмент предложения");
    },

    get(actor: ArchiveUser, id: string) {
      const row =
        actor.role === "admin"
          ? db.prepare(`${select} WHERE id=?`).get(id)
          : db
              .prepare(`${select} WHERE id=? AND created_by=?`)
              .get(id, actor.id);
      return row ? rowSuggestion(row as Record<string, unknown>) : null;
    },

    mark(actor: ArchiveUser, id: string, status: SuggestionStatus) {
      if (status === "pending") throw new Error("Некорректный статус");
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

export function applyResearchSuggestion(
  family: Family,
  suggestion: ResearchSuggestion,
) {
  if (suggestion.kind === "person_create") {
    if (family.people.some((person) => person.id === suggestion.payload.person.id))
      throw new Error("Карточка этого человека уже существует");
    return {
      ...family,
      people: [...family.people, suggestion.payload.person],
    } as Family;
  }

  if (suggestion.kind === "person_update") {
    const person = family.people.find(
      (item) => item.id === suggestion.payload.personId,
    );
    if (!person) throw new Error("Карточка человека больше не существует");
    for (const key of Object.keys(
      suggestion.payload.before,
    ) as PersonUpdateField[])
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

  if (suggestion.kind === "source") {
    const person = family.people.find(
      (item) => item.id === suggestion.payload.personId,
    );
    if (!person) throw new Error("Карточка человека больше не существует");
    if (!isDeepStrictEqual(person.sources, suggestion.payload.beforeSources))
      throw new Error(
        "Источники карточки изменились после создания предложения. Перепроверьте сведения.",
      );
    if (
      person.sources.some((item) =>
        isDeepStrictEqual(item, suggestion.payload.source),
      )
    )
      throw new Error("Такой источник уже записан");
    return {
      ...family,
      people: family.people.map((item) =>
        item.id === person.id
          ? {
              ...item,
              sources: [...item.sources, suggestion.payload.source],
            }
          : item,
      ),
    } as Family;
  }

  const payload = suggestion.payload,
    before = relationBefore(
      family,
      payload.fromPersonId,
      payload.toPersonId,
      payload.relationType,
    );
  if (!isDeepStrictEqual(before, payload.before))
    throw new Error(
      "Связи участников изменились после создания предложения. Перепроверьте сведения.",
    );
  return withRelation(family, payload);
}
