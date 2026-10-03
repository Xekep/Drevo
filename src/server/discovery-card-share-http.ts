import { createHash } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { finished } from "node:stream/promises";
import type { openArchive } from "./database.ts";
import type { createAuth } from "./auth.ts";
import { isSameOriginRequest } from "./same-origin.ts";
import { requestClientKey } from "./request-rate-limit.ts";
import { createSharedRequestLimiter } from "./shared-request-rate-limit.ts";
import { patchPeople } from "./person-patches.ts";
import { ConflictError } from "./archive-errors.ts";
import { ForbiddenError } from "./users.ts";
import { isInfrastructureError } from "./infrastructure-error.ts";
import { AccountSessionBusy } from "./account-session-guard.ts";
import { lockDiscoveryOwnerReadAccess } from "./discovery-owner-read-access.ts";
import type { Change } from "../domain/changes.ts";

const fields = ["birth", "death", "birthPlace", "deathPlace", "occupation"] as const;
type Field = typeof fields[number];
const copyFields = ["birth", "death", "birthPlace", "deathPlace"] as const;
type CopyField = typeof copyFields[number];
type CardFields = Partial<Record<Field, string>>;
type Row = Record<string, unknown>;
const limits: Record<Field, number> = {
  birth: 100, death: 100, birthPlace: 300, deathPlace: 300, occupation: 200,
};
const route = /^\/api\/discovery\/matches\/([a-f0-9-]{36})\/card-share(?:\/(copy-preview))?$/;

function objectFields(value: unknown): Record<string, unknown> {
  let parsed = value;
  if (typeof parsed === "string") {
    try { parsed = JSON.parse(parsed); } catch { return {}; }
  }
  return parsed && typeof parsed === "object" && !Array.isArray(parsed)
    ? parsed as Record<string, unknown> : {};
}

function scalarFields(value: unknown, own = false): CardFields {
  const source = objectFields(value);
  const result: CardFields = {};
  for (const key of fields) {
    const current = source[key];
    if (typeof current !== "string") continue;
    const text = current.trim();
    if (text && (own || (text.length <= limits[key] && !/[<>]/u.test(text))))
      result[key] = text;
  }
  return result;
}

function previewToken(available: CardFields) {
  return createHash("sha256").update(JSON.stringify(available)).digest("hex");
}

function copyReviewToken(pair: Row, archiveId: string, revision: number,
  grant: Row, target: CardFields) {
  return createHash("sha256").update(JSON.stringify({ pair: pairArgs(pair), archiveId,
    revision, grant: scalarFields(grant.fields), grantedAt: grant.granted_at,
    target: copyFields.map((field) => target[field] || null),
  })).digest("hex");
}

function selectedCopyFields(value: unknown): CopyField[] | null {
  if (!Array.isArray(value) || !value.length || value.length > copyFields.length ||
      value.some((item) => typeof item !== "string" ||
        !copyFields.includes(item as CopyField)) || new Set(value).size !== value.length)
    return null;
  return value as CopyField[];
}

function confirmedConflicts(value: unknown): CopyField[] | null {
  if (!Array.isArray(value) || value.length > copyFields.length ||
      value.some((item) => typeof item !== "string" ||
        !copyFields.includes(item as CopyField)) || new Set(value).size !== value.length)
    return null;
  return value as CopyField[];
}

async function readBody(req: IncomingMessage): Promise<Record<string, unknown> | null> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 2048) return null;
    chunks.push(Buffer.from(chunk));
  }
  try {
    const parsed: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed as Record<string, unknown> : null;
  } catch { return null; }
}

function selectedFields(value: unknown): Field[] | null {
  if (!Array.isArray(value) || !value.length || value.length > fields.length ||
      value.some((item) => typeof item !== "string" || !fields.includes(item as Field)) ||
      new Set(value).size !== value.length) return null;
  return value as Field[];
}

function pairArgs(row: Row) {
  return [String(row.left_archive_id),String(row.left_person_id),
    String(row.right_archive_id),String(row.right_person_id)];
}

function recipient(pair: Row, archiveId: string) {
  return {
    archiveId: String(pair.left_archive_id === archiveId
      ? pair.right_archive_id : pair.left_archive_id),
    personId: String(pair.left_archive_id === archiveId
      ? pair.right_person_id : pair.left_person_id),
  };
}

/** Extra details require a separate, revocable grant for exactly one confirmed pair. */
export function discoveryCardShareHttp({ archive, auth, publicOrigin,
  beforeCopyPreviewDelivery, beforeCardShareDelivery, beforeReadAccessLock }: {
  archive: Awaited<ReturnType<typeof openArchive>>;
  auth: Awaited<ReturnType<typeof createAuth>>;
  publicOrigin?: string;
  beforeCopyPreviewDelivery?: () => Promise<void>;
  beforeCardShareDelivery?: () => Promise<void>;
  beforeReadAccessLock?: () => Promise<void>;
}) {
  const db = archive.db;
  const limiter = createSharedRequestLimiter(db, "discovery-card-share", { windowMs: 60_000, limit: 20 });
  const json = (res: ServerResponse, code: number, value: unknown) => {
    res.writeHead(code, {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "private, no-store",
      "X-Robots-Tag": "noindex, nofollow, noarchive",
      "Referrer-Policy": "no-referrer",
    });
    res.end(JSON.stringify(value));
    return true;
  };
  const deliverLocked = async (res: ServerResponse, value: unknown) => {
    const delivered = finished(res, { cleanup: true });
    const timeout = setTimeout(() => res.destroy(), 5_000);
    timeout.unref();
    try {
      json(res, 200, value);
      await delivered;
    } catch (error) {
      const disconnected = res.destroyed;
      res.destroy();
      await delivered.catch(() => {});
      if (!disconnected) throw error;
    } finally { clearTimeout(timeout); }
  };
  const linkedPair = (id: string, archiveId: string, lock = false) => db.prepare("", `
    SELECT m.left_archive_id,m.left_person_id,m.right_archive_id,m.right_person_id
      FROM discovery_match_requests m
      JOIN discovery_linked_pairs p ON p.left_archive_id=m.left_archive_id
        AND p.left_person_id=m.left_person_id AND p.right_archive_id=m.right_archive_id
        AND p.right_person_id=m.right_person_id
     WHERE m.id=? AND m.status='linked'
       AND (m.left_archive_id=? OR m.right_archive_id=?)
     ${lock ? "FOR UPDATE OF m FOR SHARE OF p" : ""}`).get(id,archiveId,archiveId);
  const grantFor = (pair: Row, grantorArchiveId: string) => db.prepare("", `SELECT grantor_archive_id,fields,
    granted_by,granted_at::text AS granted_at,expires_at::text AS expires_at
    FROM discovery_linked_card_grants
    WHERE left_archive_id=? AND left_person_id=? AND right_archive_id=? AND right_person_id=?
      AND grantor_archive_id=? AND (expires_at IS NULL OR expires_at>now()) FOR SHARE`)
    .get(...pairArgs(pair), grantorArchiveId);
  const copyState = async (matchId: string, archiveId: string, userId: string,
    lock = false) => {
    const owner = await db.prepare("", `SELECT 1 FROM archive_owners
      WHERE archive_id=? AND user_id=? ${lock ? "FOR SHARE" : ""}`).get(archiveId, userId);
    if (!owner) return { code: 403 as const };
    const pair = await linkedPair(matchId, archiveId, lock);
    if (!pair) return { code: 404 as const };
    const ownPersonId = String(pair.left_archive_id === archiveId
      ? pair.left_person_id : pair.right_person_id);
    const sourceArchiveId = String(pair.left_archive_id === archiveId
      ? pair.right_archive_id : pair.left_archive_id);
    const sourcePersonId = String(pair.left_archive_id === archiveId
      ? pair.right_person_id : pair.left_person_id);
    const own = await db.prepare("", `SELECT data FROM people WHERE archive_id=? AND id=?
      ${lock ? "FOR SHARE" : ""}`).get(archiveId, ownPersonId);
    if (!own) return { code: 404 as const };
    const incomingGrant = () => db.prepare("", `SELECT fields,granted_at::text AS granted_at
      FROM discovery_linked_card_grants WHERE left_archive_id=? AND left_person_id=?
        AND right_archive_id=? AND right_person_id=? AND grantor_archive_id=?
        AND (expires_at IS NULL OR expires_at>now())
      ${lock ? "FOR SHARE" : ""}`).get(...pairArgs(pair), sourceArchiveId);
    let grant: Row | undefined;
    if (lock) {
      // Row-locking SELECT also applies the UPDATE RLS policy. The recipient
      // may read this grant but only its grantor may lock it. Scope the one
      // exact-row lock to that grantor, then restore the recipient context
      // before any archive write or auth query. DELETE/revoke must wait for
      // this lock, including a cascade after unpublication.
      await db.prepare("", "SELECT set_config('drevo.archive_id',?,true)")
        .get(sourceArchiveId);
      try { grant = await incomingGrant(); }
      finally {
        await db.prepare("", "SELECT set_config('drevo.archive_id',?,true)")
          .get(archiveId);
      }
    } else grant = await incomingGrant();
    if (!grant) return { code: 404 as const };
    const revision = Number((await db.prepare("", `SELECT revision FROM archives WHERE id=?`)
      .get(archiveId))?.revision);
    if (!Number.isSafeInteger(revision)) throw new Error("Некорректная версия архива");
    const target = scalarFields(own.data, true);
    return { code: 200 as const, pair, own, ownPersonId, sourceArchiveId,
      sourcePersonId, grant, revision, target,
      permitted: scalarFields(grant.fields),
      reviewToken: copyReviewToken(pair, archiveId, revision, grant, target) };
  };
  return async (req: IncomingMessage, res: ServerResponse, url: URL) => {
    const detail = route.exec(url.pathname);
    if (!detail) return false;
    if (db.kind !== "postgres" || !db.archiveId)
      return json(res, 501, { error: "Доступ к связанной карточке доступен с PostgreSQL" });
    const user = await auth.currentUser(req);
    if (!user) return json(res, 401, { error: "Войдите в архив" });
    if (user.role !== "admin" || user.approved !== true)
      return json(res, 403, { error: "Доступно владельцу дерева" });
    if (detail[2]) {
      if (req.method !== "GET" && req.method !== "POST")
        return json(res, 405, { error: "Метод не поддерживается" });
      const archiveId = db.archiveId;
      if (req.method === "GET") {
        const session = await auth.accountSession(req);
        await beforeReadAccessLock?.();
        const result = await db.transaction(async () => {
          if (!await lockDiscoveryOwnerReadAccess(db, auth.local, session, user))
            return { code: 403 as const };
          // Hold the pair and grant row through response completion so a
          // concurrent revoke cannot commit before these fields are sent.
          const state = await copyState(detail[1], archiveId, user.id, true);
          if (state.code !== 200) return state;
          const origins = await db.prepare("", `SELECT field,value,source_archive_id,
            source_person_id,copied_revision,copied_at::text AS copied_at
            FROM discovery_copied_fields WHERE archive_id=? AND person_id=?`)
            .all(archiveId, state.ownPersonId);
          const originByField = new Map(origins.map((row) => [String(row.field), row]));
          // Only the current grant's scalar keys are returned. Provenance is
          // local metadata, not a documentary source or a new access grant.
          const payload = {
            source: { archiveId: state.sourceArchiveId, personId: state.sourcePersonId },
            target: { archiveId, personId: state.ownPersonId },
            revision: state.revision, reviewToken: state.reviewToken,
            fields: fields.filter((field) => state.permitted[field]).map((field) => {
              const prior = originByField.get(field);
              return { field, sourceValue: state.permitted[field]!,
                targetValue: state.target[field] || null,
                status: !state.target[field] ? "empty"
                  : state.target[field] === state.permitted[field] ? "same" : "conflict",
                copyable: copyFields.includes(field as CopyField),
                ...(prior && prior.value === state.target[field] ? { copiedFrom: {
                  archiveId: String(prior.source_archive_id),
                  personId: String(prior.source_person_id),
                  revision: Number(prior.copied_revision),
                  copiedAt: String(prior.copied_at),
                } } : {}),
              };
            }), quotaImpact: { additionalPeople: 0, additionalMediaBytes: 0 } };
          await beforeCopyPreviewDelivery?.();
          const delivered = finished(res, { cleanup: true });
          // A stalled client must not hold the grant and pair locks indefinitely.
          const timeout = setTimeout(() => res.destroy(), 5_000);
          timeout.unref();
          try {
            json(res, 200, payload);
            await delivered;
          } catch (error) {
            const disconnected = res.destroyed;
            res.destroy();
            await delivered.catch(() => {});
            // The socket is already gone; do not ask the outer HTTP error
            // handler to attempt another response after a client abort.
            if (disconnected) return { code: 200 as const };
            throw error;
          } finally { clearTimeout(timeout); }
          return { code: 200 as const };
        }).catch((error) => {
          if (error instanceof AccountSessionBusy ||
              (error as { code?: string }).code === "55P03")
            return { code: 409 as const };
          throw error;
        });
        if (result.code === 200) return true;
        return json(res, result.code, { error: result.code === 403
          ? "Доступно владельцу дерева" : result.code === 409
            ? "Доступ изменяется. Повторите запрос" : "Связь не найдена" });
      }
      if (!isSameOriginRequest(req, publicOrigin))
        return json(res, 403, { error: "Недопустимый источник запроса" });
      if (!(await limiter.allow(requestClientKey(req.headers["x-real-ip"], req.socket.remoteAddress))))
        return json(res, 429, { error: "Слишком много запросов" });
      const body = await readBody(req);
      const selected = selectedCopyFields(body?.fields);
      const confirmed = confirmedConflicts(body?.confirmConflicts);
      if (!selected || !confirmed || typeof body?.reviewToken !== "string" ||
          !/^[0-9a-f]{64}$/.test(body.reviewToken) ||
          !Number.isSafeInteger(body.revision) || Number(body.revision) < 0)
        return json(res, 400, { error: "Выберите поля после просмотра сравнения" });
      try {
        const result = await db.transaction(async () => {
          const state = await copyState(detail[1], archiveId, user.id, true);
          if (state.code !== 200) return state;
          const approved = await auth.currentUser(req);
          if (approved?.id !== user.id || approved.role !== "admin" || approved.approved !== true)
            return { code: 403 as const };
          if (Number(body.revision) !== state.revision || body.reviewToken !== state.reviewToken)
            return { code: 409 as const };
          if (selected.some((field) => !state.permitted[field] ||
              state.target[field] === state.permitted[field]))
            return { code: 409 as const };
          const conflicts = selected.filter((field) => Boolean(state.target[field]));
          if (confirmed.length !== conflicts.length ||
              confirmed.some((field) => !conflicts.includes(field)))
            return { code: 409 as const };
          const current = objectFields(state.own.data);
          const changes: Change[] = selected.map((field) => ({
            collection: "people", id: state.ownPersonId, field,
            before: current[field], after: state.permitted[field],
          }));
          const saved = await patchPeople(db, changes, state.revision, approved,
            { withinTransaction: true });
          if (!saved || !saved.appliedChanges.length) return { code: 409 as const };
          for (const field of selected)
            await db.prepare("", `INSERT INTO discovery_copied_fields(archive_id,person_id,
              field,value,source_archive_id,source_person_id,copied_revision)
              VALUES(?,?,?,?,?,?,?)
              ON CONFLICT(archive_id,person_id,field) DO UPDATE SET
                value=EXCLUDED.value,source_archive_id=EXCLUDED.source_archive_id,
                source_person_id=EXCLUDED.source_person_id,
                copied_revision=EXCLUDED.copied_revision,copied_at=now()`)
              .run(archiveId, state.ownPersonId, field, state.permitted[field]!,
                state.sourceArchiveId, state.sourcePersonId, saved.revision);
          return { code: 200 as const, revision: saved.revision, copied: selected };
        });
        return result.code === 200 ? json(res, 200, {
          revision: result.revision, copied: result.copied,
        }) : json(res, result.code, { error: result.code === 403
          ? "Доступ отозван" : result.code === 404 ? "Связь не найдена"
            : "Сведения изменились. Проверьте сравнение ещё раз" });
      } catch (error) {
        if (isInfrastructureError(error) ||
            typeof (error as { code?: unknown })?.code === "string") throw error;
        return json(res, error instanceof ConflictError ? 409
          : error instanceof ForbiddenError ? 403 : 400,
        { error: error instanceof Error ? error.message : "Не удалось скопировать сведения" });
      }
    }
    if (req.method !== "GET" && !isSameOriginRequest(req, publicOrigin))
      return json(res, 403, { error: "Недопустимый источник запроса" });
    if (req.method !== "GET" && req.method !== "PUT" && req.method !== "DELETE")
      return json(res, 405, { error: "Метод не поддерживается" });
    if (req.method !== "GET" &&
        !(await limiter.allow(requestClientKey(req.headers["x-real-ip"], req.socket.remoteAddress))))
      return json(res, 429, { error: "Слишком много запросов" });
    const archiveId = db.archiveId;
    if (req.method === "GET") {
      const session = await auth.accountSession(req);
      await beforeReadAccessLock?.();
      const result = await db.transaction(async () => {
        if (!await lockDiscoveryOwnerReadAccess(db, auth.local, session, user))
          return { forbidden: true };
        if (!await db.prepare("", `SELECT 1 FROM archive_owners
          WHERE archive_id=? AND user_id=? FOR SHARE`).get(archiveId,user.id))
          return { forbidden: true };
        const preliminary = await linkedPair(detail[1],archiveId);
        if (!preliminary) return null;
        const addressee = recipient(preliminary, archiveId);
        const ownPersonId = String(preliminary.left_archive_id === archiveId
          ? preliminary.left_person_id : preliminary.right_person_id);
        // Family edits lock people before refreshing the public projection,
        // and unpublication locks discovery_people before revoking the pair.
        const own = await db.prepare("", "SELECT data FROM people WHERE archive_id=? AND id=? FOR SHARE")
          .get(archiveId,ownPersonId);
        if (!own) return null;
        const publishedRecipient = await db.prepare("", `SELECT name FROM discovery_people
          WHERE archive_id=? AND person_id=? FOR SHARE`)
          .get(addressee.archiveId,addressee.personId);
        if (!publishedRecipient) return null;
        const pair = await linkedPair(detail[1],archiveId,true);
        if (!pair || pairArgs(pair).some((value,index) =>
          value !== pairArgs(preliminary)[index])) return null;
        const available = scalarFields(own.data);
        const outgoing = await grantFor(pair, archiveId);
        // SELECT FOR SHARE applies the grant's UPDATE RLS policy. Lock only
        // the other owner's addressed grant in its grantor scope.
        await db.prepare("", "SELECT set_config('drevo.archive_id',?,true)")
          .get(addressee.archiveId);
        let incoming: Row | undefined;
        try { incoming = await grantFor(pair, addressee.archiveId); }
        finally {
          await db.prepare("", "SELECT set_config('drevo.archive_id',?,true)")
            .get(archiveId);
        }
        const grant = (row: Row | undefined) => row ? {
          fields: scalarFields(row.fields), grantedAt: String(row.granted_at),
          expiresAt: row.expires_at ? String(row.expires_at) : null,
        } : null;
        const payload = { available, previewToken: previewToken(available),
          recipientArchiveId: addressee.archiveId,
          recipientPersonName: String(publishedRecipient.name),
          outgoing: grant(outgoing), incoming: grant(incoming) };
        await beforeCardShareDelivery?.();
        await deliverLocked(res, payload);
        return { delivered: true };
      }).catch((error) => {
        if (error instanceof AccountSessionBusy ||
            (error as { code?: string }).code === "55P03")
          return { busy: true };
        throw error;
      });
      if (result && "busy" in result)
        return json(res, 409, { error: "Доступ изменяется. Повторите запрос" });
      if (result && "forbidden" in result)
        return json(res, 403, { error: "Доступно владельцу дерева" });
      return result ? true : json(res, 404, { error: "Связь не найдена" });
    }
    if (req.method === "PUT") {
      const body = await readBody(req);
      const selected = selectedFields(body?.fields);
      const durationDays = body?.durationDays;
      if (!selected || typeof body?.previewToken !== "string" ||
          !/^[0-9a-f]{64}$/.test(body.previewToken) ||
          typeof body?.recipientArchiveId !== "string" || body.recipientArchiveId.length > 64 ||
          typeof durationDays !== "number" || ![1,7,30].includes(durationDays))
        return json(res, 400, { error: "Выберите доступные поля после просмотра карточки" });
      const result = await db.transaction(async () => {
        if (!await db.prepare("", `SELECT 1 FROM archive_owners
          WHERE archive_id=? AND user_id=? FOR SHARE`).get(archiveId,user.id))
          return { code: 403, error: "Доступно владельцу дерева" };
        const preliminary = await linkedPair(detail[1],archiveId);
        if (!preliminary) return { code: 404, error: "Связь не найдена" };
        if (body.recipientArchiveId !== recipient(preliminary,archiveId).archiveId)
          return { code: 409, error: "Адресат изменился. Проверьте разрешение заново" };
        const ownPersonId = String(preliminary.left_archive_id === archiveId
          ? preliminary.left_person_id : preliminary.right_person_id);
        // Family edits lock people before refreshing the discovery projection.
        const own = await db.prepare("", "SELECT data FROM people WHERE archive_id=? AND id=? FOR SHARE")
          .get(archiveId,ownPersonId);
        if (!own) return { code: 404, error: "Связь не найдена" };
        const available = scalarFields(own.data);
        if (body.previewToken !== previewToken(available))
          return { code: 409, error: "Карточка изменилась. Проверьте поля ещё раз" };
        if (selected.some((field) => !available[field]))
          return { code: 409, error: "Выбранное поле больше недоступно" };
        const pair = await linkedPair(detail[1],archiveId,true);
        if (!pair || pairArgs(pair).some((value,index) => value !== pairArgs(preliminary)[index]))
          return { code: 404, error: "Связь не найдена" };
        const approved = await auth.currentUser(req);
        if (approved?.role !== "admin" || approved.approved !== true)
          return { code: 403, error: "Доступ отозван" };
        const snapshot: CardFields = {};
        for (const field of selected) snapshot[field] = available[field];
        await db.prepare("", `INSERT INTO discovery_linked_card_grants(
          left_archive_id,left_person_id,right_archive_id,right_person_id,
          grantor_archive_id,fields,granted_by,expires_at)
          VALUES(?,?,?,?,?,?::jsonb,?,now() + (?::int * interval '1 day'))
          ON CONFLICT(left_archive_id,left_person_id,right_archive_id,right_person_id,grantor_archive_id)
          DO UPDATE SET fields=EXCLUDED.fields,granted_by=EXCLUDED.granted_by,
            granted_at=now(),expires_at=EXCLUDED.expires_at`)
          .run(...pairArgs(pair),archiveId,JSON.stringify(snapshot),approved.id,durationDays);
        return { code: 200, fields: snapshot };
      });
      return "fields" in result ? json(res, 200, { fields: result.fields })
        : json(res, result.code, { error: result.error });
    }
    const result = await db.transaction(async () => {
      if (!await db.prepare("", `SELECT 1 FROM archive_owners
        WHERE archive_id=? AND user_id=? FOR SHARE`).get(archiveId,user.id))
        return { code: 403, error: "Доступно владельцу дерева" };
      const pair = await linkedPair(detail[1],archiveId,true);
      if (!pair) return { code: 404, error: "Связь не найдена" };
      const approved = await auth.currentUser(req);
      if (approved?.role !== "admin" || approved.approved !== true)
        return { code: 403, error: "Доступ отозван" };
      await db.prepare("", `DELETE FROM discovery_linked_card_grants
        WHERE left_archive_id=? AND left_person_id=? AND right_archive_id=? AND right_person_id=?
          AND grantor_archive_id=?`).run(...pairArgs(pair),archiveId);
      return { code: 200 };
    });
    return result.code === 200 ? json(res, 200, { shared: false })
      : json(res, result.code, { error: result.error });
  };
}
