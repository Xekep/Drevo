import { createHash } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { finished } from "node:stream/promises";
import type { openArchive } from "./database.ts";
import type { createAuth } from "./auth.ts";
import { isSameOriginRequest } from "./same-origin.ts";
import { requestClientKey } from "./request-rate-limit.ts";
import { createSharedRequestLimiter } from "./shared-request-rate-limit.ts";
import type { Family } from "../domain/types.ts";
import type { DiscoveryBranchRelation } from "../shared/discovery-branch.ts";
import { AccountSessionBusy } from "./account-session-guard.ts";
import { lockDiscoveryOwnerReadAccess } from "./discovery-owner-read-access.ts";
import { isArchiveOwner } from "../domain/access.ts";

type Row = Record<string, unknown>;
type Relation = DiscoveryBranchRelation;
type Member = { id: string; relation: Relation; name: string; birthYear?: string;
  deathYear?: string; birthPlace?: string; deathPlace?: string; publicationVersion: string;
  viaIds?: string[]; viaId?: string };
const route = /^\/api\/discovery\/matches\/([a-f0-9-]{36})\/branch-share(?:\/people\/([^/]{1,1200}))?$/;
const maxMembers = 20;

async function readBody(req: IncomingMessage): Promise<Record<string, unknown> | null> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 4096) return null;
    chunks.push(Buffer.from(chunk));
  }
  try {
    const body: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    return body && typeof body === "object" && !Array.isArray(body)
      ? body as Record<string, unknown> : null;
  } catch { return null; }
}

function pairArgs(pair: Row) {
  return [String(pair.left_archive_id), String(pair.left_person_id),
    String(pair.right_archive_id), String(pair.right_person_id)];
}

function directRelations(family: Family, rootId: string): Map<string, Relation> {
  const root = family.people.find((person) => person.id === rootId);
  const result = new Map<string, Relation>();
  if (!root) return result;
  for (const id of root.parents) if (id !== rootId) result.set(id, "parent");
  for (const id of root.spouses) if (id !== rootId && !result.has(id)) result.set(id, "spouse");
  for (const person of family.people)
    if (person.id !== rootId && person.parents.includes(rootId) && !result.has(person.id))
      result.set(person.id, "child");
  return result;
}

function secondGeneration(family: Family, rootId: string,
  direct: Map<string, Relation>, publishedDirect: Set<string>) {
  const people = new Map(family.people.map((person) => [person.id,person]));
  const children = new Map<string,string[]>();
  for (const person of family.people) for (const parentId of person.parents) {
    const familyChildren = children.get(parentId) || [];
    familyChildren.push(person.id);
    children.set(parentId, familyChildren);
  }
  const result = new Map<string,{ relation: Relation; viaIds: string[] }>();
  const add = (id: string, relation: Relation, viaId: string) => {
    if (id === rootId || direct.has(id) || !people.has(id)) return;
    const existing = result.get(id);
    if (existing) {
      if (existing.relation === relation && !existing.viaIds.includes(viaId))
        existing.viaIds.push(viaId);
    } else result.set(id, { relation, viaIds: [viaId] });
  };
  for (const [viaId, relation] of [...direct].sort(([a],[b]) => a.localeCompare(b))) {
    if (!publishedDirect.has(viaId)) continue;
    if (relation === "parent") {
      for (const id of people.get(viaId)?.parents || []) add(id, "grandparent", viaId);
      for (const id of children.get(viaId) || []) add(id, "sibling", viaId);
    } else if (relation === "child") {
      for (const id of children.get(viaId) || []) add(id, "grandchild", viaId);
    }
  }
  return result;
}

function listed(row: Row, relation: Relation, viaIds?: string[]): Member {
  return {
    id: String(row.person_id), relation, name: String(row.name),
    ...(row.birth_year ? { birthYear: String(row.birth_year) } : {}),
    ...(row.death_year ? { deathYear: String(row.death_year) } : {}),
    ...(row.birth_place ? { birthPlace: String(row.birth_place) } : {}),
    ...(row.death_place ? { deathPlace: String(row.death_place) } : {}),
    publicationVersion: String(row.publication_version),
    ...(viaIds?.length ? { viaIds } : {}),
    ...(row.via_person_id ? { viaId: String(row.via_person_id) } : {}),
  };
}

/** Only a mutual opt-in on this exact linked pair exposes published direct relatives. */
export function discoveryBranchShareHttp({ archive, auth, publicOrigin,
  beforeMemberDelivery, beforeListPublicationLock, beforeListDelivery,
  beforeReadAccessLock }: {
  archive: Awaited<ReturnType<typeof openArchive>>;
  auth: Awaited<ReturnType<typeof createAuth>>;
  publicOrigin?: string;
  beforeMemberDelivery?: () => Promise<void>;
  beforeListPublicationLock?: () => Promise<void>;
  beforeListDelivery?: () => Promise<void>;
  beforeReadAccessLock?: () => Promise<void>;
}) {
  const db = archive.db;
  const limiter = createSharedRequestLimiter(db, "discovery-branch-share", { windowMs: 60_000, limit: 20 });
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
    // Bound the connection and row locks held for a slow recipient.
    const timeout = setTimeout(() => res.destroy(), 5_000);
    timeout.unref();
    try {
      json(res, 200, value);
      await delivered;
    } catch (error) {
      const disconnected = res.destroyed;
      res.destroy();
      await delivered.catch(() => {});
      // The socket is gone; do not let the outer handler write another reply.
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
     ${lock ? "FOR UPDATE OF m FOR SHARE OF p" : ""}`).get(id, archiveId, archiveId);
  const ownRoot = (pair: Row, archiveId: string) => String(
    pair.left_archive_id === archiveId ? pair.left_person_id : pair.right_person_id);
  const recipient = (pair: Row, archiveId: string) => ({
    archiveId: String(pair.left_archive_id === archiveId
      ? pair.right_archive_id : pair.left_archive_id),
    personId: String(pair.left_archive_id === archiveId
      ? pair.right_person_id : pair.left_person_id),
  });
  const availableFor = async (pair: Row, archiveId: string) => {
    const snapshot = await archive.read();
    const relations = directRelations(snapshot.family, ownRoot(pair, archiveId));
    const ids = [...relations.keys()].sort();
    const directRows = ids.length ? await db.prepare("", `SELECT person_id,name,birth_year,death_year,
      birth_place,death_place,publication_version FROM discovery_people
      WHERE archive_id=? AND person_id IN (SELECT jsonb_array_elements_text(?::jsonb))
      ORDER BY person_id LIMIT 51`).all(archiveId, JSON.stringify(ids)) : [];
    const publishedDirect = directRows.slice(0,50);
    const second = secondGeneration(snapshot.family, ownRoot(pair, archiveId),
      relations, new Set(publishedDirect.map((row) => String(row.person_id))));
    const remaining = Math.max(0, 50 - publishedDirect.length);
    const secondRows = second.size ? await db.prepare("", `SELECT person_id,name,
      birth_year,death_year,birth_place,death_place,publication_version FROM discovery_people
      WHERE archive_id=? AND person_id IN (SELECT jsonb_array_elements_text(?::jsonb))
      ORDER BY person_id LIMIT ?`).all(archiveId, JSON.stringify([...second.keys()]), remaining + 1) : [];
    const available = [
      ...publishedDirect.map((row) => listed(row, relations.get(String(row.person_id))!)),
      ...secondRows.slice(0,remaining).map((row) => {
        const candidate = second.get(String(row.person_id))!;
        return listed(row, candidate.relation, candidate.viaIds);
      }),
    ].sort((a,b) => a.id.localeCompare(b.id));
    const previewToken = createHash("sha256").update(JSON.stringify({
      archiveId, pair: pairArgs(pair), revision: snapshot.revision, available,
    })).digest("hex");
    return { available, truncated: directRows.length > 50 || secondRows.length > remaining,
      previewToken };
  };
  const grantsFor = (pair: Row) => db.prepare("", `SELECT grantor_archive_id,expires_at
    FROM discovery_branch_grants
    WHERE left_archive_id=? AND left_person_id=? AND right_archive_id=? AND right_person_id=?
      AND (expires_at IS NULL OR expires_at>now())`)
    .all(...pairArgs(pair));
  const isOwner = async (archiveId: string, userId: string, lock = false) => Boolean(
    await db.prepare("", `SELECT 1 FROM archive_owners WHERE archive_id=? AND user_id=?
      ${lock ? "FOR SHARE" : ""}`).get(archiveId, userId));
  const lockedGrantsFor = async (pair: Row, archiveId: string, sourceArchiveId: string) => {
    const lockGrant = (grantorArchiveId: string) => db.prepare("", `SELECT 1
      FROM discovery_branch_grants WHERE left_archive_id=? AND left_person_id=?
        AND right_archive_id=? AND right_person_id=? AND grantor_archive_id=?
        AND (expires_at IS NULL OR expires_at>now()) FOR SHARE`)
      .get(...pairArgs(pair), grantorArchiveId);
    const own = Boolean(await lockGrant(archiveId));
    // SELECT FOR SHARE applies the grant's UPDATE RLS policy. Lock the
    // source's exact grant as its grantor, then restore recipient scope.
    await db.prepare("", "SELECT set_config('drevo.archive_id',?,true)")
      .get(sourceArchiveId);
    let source: Row | undefined;
    try { source = await lockGrant(sourceArchiveId); }
    finally {
      await db.prepare("", "SELECT set_config('drevo.archive_id',?,true)")
        .get(archiveId);
    }
    return { own, source: Boolean(source) };
  };
  return async (req: IncomingMessage, res: ServerResponse, url: URL) => {
    const detail = route.exec(url.pathname);
    if (!detail) return false;
    let memberId: string | null = null;
    if (detail[2]) {
      try { memberId = decodeURIComponent(detail[2]); }
      catch { return json(res, 404, { error: "Карточка недоступна" }); }
      if (!memberId || memberId.length > 100)
        return json(res, 404, { error: "Карточка недоступна" });
    }
    if (db.kind !== "postgres" || !db.archiveId)
      return json(res, 501, { error: "Просмотр ветки доступен с PostgreSQL" });
    const user = await auth.currentUser(req);
    if (!user) return json(res, 401, { error: "Войдите в архив" });
    if (!isArchiveOwner(user) || user.approved !== true)
      return json(res, 403, { error: "Доступно владельцу дерева" });
    if (!(await isOwner(db.archiveId, user.id)))
      return json(res, 403, { error: "Доступно владельцу дерева" });
    if (req.method !== "GET" && !isSameOriginRequest(req, publicOrigin))
      return json(res, 403, { error: "Недопустимый источник запроса" });
    if ((detail[2] && req.method !== "GET") ||
        (req.method !== "GET" && req.method !== "PUT" && req.method !== "DELETE"))
      return json(res, 405, { error: "Метод не поддерживается" });
    if (!(await limiter.allow(requestClientKey(req.headers["x-real-ip"], req.socket.remoteAddress))))
      return json(res, 429, { error: "Слишком много запросов" });
    const archiveId = db.archiveId;
    if (memberId) {
      const session = await auth.accountSession(req);
      await beforeReadAccessLock?.();
      const personId = memberId;
      const person = await db.transaction(async () => {
        if (!await lockDiscoveryOwnerReadAccess(db, auth.local, session, user)) return false;
        const preliminary = await linkedPair(detail[1], archiveId);
        if (!preliminary) return false;
        const sourceArchiveId = recipient(preliminary, archiveId).archiveId;
        const preliminaryMember = await db.prepare("", `SELECT via_person_id
          FROM discovery_branch_members WHERE left_archive_id=? AND left_person_id=?
            AND right_archive_id=? AND right_person_id=? AND grantor_archive_id=?
            AND person_id=?`).get(...pairArgs(preliminary), sourceArchiveId, personId);
        if (!preliminaryMember) return false;
        const publicationIds = [...new Set([personId,
          ...(preliminaryMember.via_person_id ? [String(preliminaryMember.via_person_id)] : [])])]
          .sort();
        // Unpublication locks discovery_people before it cascades into branch
        // members or the linked pair. Take the same order to avoid a cycle.
        const published = await db.prepare("", `SELECT person_id FROM discovery_people
          WHERE archive_id=? AND person_id IN (SELECT jsonb_array_elements_text(?::jsonb))
          ORDER BY person_id FOR SHARE`).all(sourceArchiveId, JSON.stringify(publicationIds));
        if (published.length !== publicationIds.length) return false;
        const pair = await linkedPair(detail[1], archiveId, true);
        if (!pair || pairArgs(pair).some((value, index) =>
          value !== pairArgs(preliminary)[index])) return false;
        if (!(await isOwner(archiveId, user.id, true))) return false;
        const grants = await lockedGrantsFor(pair, archiveId, sourceArchiveId);
        if (!grants.own || !grants.source) return false;
        const row = await db.prepare("", `SELECT p.archive_id,p.person_id,p.name,p.birth_year,
          p.death_year,p.birth_place,p.death_place,b.relation,b.via_person_id
          FROM discovery_branch_members b JOIN discovery_people p
            ON p.archive_id=b.grantor_archive_id AND p.person_id=b.person_id
          WHERE b.left_archive_id=? AND b.left_person_id=? AND b.right_archive_id=?
            AND b.right_person_id=? AND b.grantor_archive_id<>? AND b.person_id=?`)
          .get(...pairArgs(pair), archiveId, personId);
        if (!row || row.via_person_id !== preliminaryMember.via_person_id) return false;
        const member = {
          archiveId: String(row.archive_id), id: String(row.person_id),
          relation: String(row.relation) as Relation, name: String(row.name),
          ...(row.birth_year ? { birthYear: String(row.birth_year) } : {}),
          ...(row.death_year ? { deathYear: String(row.death_year) } : {}),
          ...(row.birth_place ? { birthPlace: String(row.birth_place) } : {}),
          ...(row.death_place ? { deathPlace: String(row.death_place) } : {}),
          ...(row.via_person_id ? { viaId: String(row.via_person_id) } : {}),
        };
        await beforeMemberDelivery?.();
        await deliverLocked(res, { person: member });
        return true;
      }).catch((error) => {
        if (error instanceof AccountSessionBusy ||
            (error as { code?: string }).code === "55P03")
          return { busy: true };
        throw error;
      });
      if (person && typeof person === "object" && "busy" in person)
        return json(res, 409, { error: "Доступ изменяется. Повторите запрос" });
      return person ? true : json(res, 404, { error: "Карточка недоступна" });
    }
    if (req.method === "GET") {
      const session = await auth.accountSession(req);
      await beforeReadAccessLock?.();
      const result = await db.transaction(async () => {
        if (!await lockDiscoveryOwnerReadAccess(db, auth.local, session, user)) return null;
        const preliminary = await linkedPair(detail[1], archiveId);
        if (!preliminary) return null;
        const sourceArchiveId = recipient(preliminary, archiveId).archiveId;
        const selected = await db.prepare("", `SELECT person_id,via_person_id
          FROM discovery_branch_members WHERE left_archive_id=? AND left_person_id=?
            AND right_archive_id=? AND right_person_id=? AND grantor_archive_id=?
          ORDER BY person_id LIMIT ?`).all(...pairArgs(preliminary), sourceArchiveId, maxMembers);
        await beforeListPublicationLock?.();
        const publicationIds = [...new Set(selected.flatMap((row) => [String(row.person_id),
          ...(row.via_person_id ? [String(row.via_person_id)] : [])]))].sort();
        // Publication withdrawal precedes its member cascade and may precede
        // a linked-pair revoke. Take public row locks before the pair lock.
        const published = publicationIds.length ? await db.prepare("", `SELECT person_id
          FROM discovery_people WHERE archive_id=?
            AND person_id IN (SELECT jsonb_array_elements_text(?::jsonb))
          ORDER BY person_id FOR SHARE`).all(sourceArchiveId, JSON.stringify(publicationIds)) : [];
        const lockedPublications = new Set(published.map((row) => String(row.person_id)));
        const pair = await linkedPair(detail[1], archiveId, true);
        if (!pair || pairArgs(pair).some((value, index) =>
          value !== pairArgs(preliminary)[index])) return null;
        if (!(await isOwner(archiveId, user.id, true))) return null;
        const lockedGrants = await lockedGrantsFor(pair, archiveId, sourceArchiveId);
        const addressee = recipient(pair, archiveId);
        const publishedRecipient = await db.prepare("", `SELECT name FROM discovery_people
          WHERE archive_id=? AND person_id=?`).get(addressee.archiveId,addressee.personId);
        if (!publishedRecipient) return null;
        const preview = await availableFor(pair, archiveId);
        const grants = await grantsFor(pair);
        const ownGrant = grants.find((row) => row.grantor_archive_id === archiveId);
        const ownReady = Boolean(ownGrant);
        const otherReady = grants.some((row) => row.grantor_archive_id !== archiveId);
        const ownRows = ownReady ? await db.prepare("", `SELECT person_id FROM discovery_branch_members
          WHERE left_archive_id=? AND left_person_id=? AND right_archive_id=? AND right_person_id=?
            AND grantor_archive_id=?`).all(...pairArgs(pair), archiveId) : [];
        const outgoingIds = ownRows.map((row) => String(row.person_id));
        const incoming = ownReady && otherReady ? await db.prepare("", `SELECT
          p.person_id,p.name,p.birth_year,p.death_year,p.birth_place,p.death_place,
          p.publication_version,b.relation,b.via_person_id FROM discovery_branch_members b
          JOIN discovery_people p ON p.archive_id=b.grantor_archive_id AND p.person_id=b.person_id
          WHERE b.left_archive_id=? AND b.left_person_id=? AND b.right_archive_id=?
            AND b.right_person_id=? AND b.grantor_archive_id<>?
          ORDER BY p.person_id LIMIT ?`).all(...pairArgs(pair), archiveId, maxMembers) : [];
        if (incoming.some((row) => !lockedPublications.has(String(row.person_id)) ||
            (row.via_person_id && !lockedPublications.has(String(row.via_person_id)))) ||
            (incoming.length > 0 && (!lockedGrants.own || !lockedGrants.source)))
          return { code: 409 as const };
        const payload = { ...preview, ownReady, otherReady, outgoingIds,
          recipientArchiveId: addressee.archiveId,
          recipientPersonName: String(publishedRecipient.name),
          ownExpiresAt: ownGrant?.expires_at || null,
          incoming: incoming.map((row) => listed(row, String(row.relation) as Relation)) };
        await beforeListDelivery?.();
        await deliverLocked(res, payload);
        return { code: 200 as const };
      }).catch((error) => {
        if (error instanceof AccountSessionBusy ||
            (error as { code?: string }).code === "55P03")
          return { code: 409 as const };
        throw error;
      });
      return !result ? json(res, 404, { error: "Связь не найдена" })
        : result.code === 409 ? json(res, 409, { error: "Ветка изменилась. Повторите запрос" })
          : true;
    }
    if (req.method === "PUT") {
      const body = await readBody(req);
      const ids = body?.personIds;
      const durationDays = body?.durationDays;
      if (!Array.isArray(ids) || ids.length > maxMembers ||
          ids.some((id) => typeof id !== "string" || id.length > 100) ||
          new Set(ids).size !== ids.length ||
          typeof body?.recipientArchiveId !== "string" || body.recipientArchiveId.length > 64 ||
          typeof durationDays !== "number" || ![1,7,30].includes(durationDays) ||
          typeof body?.previewToken !== "string" || !/^[0-9a-f]{64}$/.test(body.previewToken))
        return json(res, 400, { error: "Выберите людей после просмотра ветки" });
      const result = await db.transaction(async () => {
        const pair = await linkedPair(detail[1], archiveId);
        if (!pair) return { code: 404, error: "Связь не найдена" };
        if (body.recipientArchiveId !== recipient(pair, archiveId).archiveId)
          return { code: 409, error: "Адресат изменился. Проверьте разрешение заново" };
        const selectedIds = ids as string[];
        const lockIds = [ownRoot(pair, archiveId), ...selectedIds];
        await db.prepare("", `SELECT id FROM people WHERE archive_id=?
          AND id IN (${lockIds.map(() => "?").join(",")}) FOR SHARE`).all(archiveId, ...lockIds);
        const preview = await availableFor(pair, archiveId);
        if (preview.previewToken !== body.previewToken ||
            selectedIds.some((id) => {
              const person = preview.available.find((item) => item.id === id);
              return !person || (person.viaIds?.length &&
                !person.viaIds.some((viaId) => selectedIds.includes(viaId)));
            }))
          return { code: 409, error: "Ветка изменилась. Проверьте выбранных людей ещё раз" };
        const locked = await linkedPair(detail[1], archiveId, true);
        if (!locked || pairArgs(locked).some((value, index) => value !== pairArgs(pair)[index]))
          return { code: 404, error: "Связь не найдена" };
        const approved = await auth.currentUser(req);
        if (!isArchiveOwner(approved) || approved?.approved !== true || approved.id !== user.id)
          return { code: 403, error: "Доступ отозван" };
        if (!(await isOwner(archiveId, approved.id, true)))
          return { code: 403, error: "Доступ отозван" };
        await db.prepare("", `DELETE FROM discovery_branch_grants WHERE left_archive_id=?
          AND left_person_id=? AND right_archive_id=? AND right_person_id=?
          AND grantor_archive_id=?`).run(...pairArgs(pair), archiveId);
        await db.prepare("", `INSERT INTO discovery_branch_grants(left_archive_id,left_person_id,
          right_archive_id,right_person_id,grantor_archive_id,granted_by,expires_at)
          VALUES(?,?,?,?,?,?,now() + (?::int * interval '1 day'))`)
          .run(...pairArgs(pair), archiveId, approved.id, durationDays);
        for (const id of [...selectedIds].sort((a,b) => {
          const first = preview.available.find((item) => item.id === a)!;
          const second = preview.available.find((item) => item.id === b)!;
          return Number(Boolean(first.viaIds)) - Number(Boolean(second.viaIds));
        })) {
          const person = preview.available.find((item) => item.id === id)!;
          await db.prepare("", `INSERT INTO discovery_branch_members(left_archive_id,left_person_id,
            right_archive_id,right_person_id,grantor_archive_id,person_id,relation,via_person_id)
            VALUES(?,?,?,?,?,?,?,?)`).run(...pairArgs(pair), archiveId, id, person.relation,
            person.viaIds?.find((viaId) => selectedIds.includes(viaId)) || null);
        }
        return { code: 200 };
      });
      return result.code === 200 ? json(res, 200, { shared: true })
        : json(res, result.code, { error: result.error });
    }
    const result = await db.transaction(async () => {
      const pair = await linkedPair(detail[1], archiveId, true);
      if (!pair) return { code: 404, error: "Связь не найдена" };
      const approved = await auth.currentUser(req);
      if (!isArchiveOwner(approved) || approved?.approved !== true || approved.id !== user.id)
        return { code: 403, error: "Доступ отозван" };
      if (!(await isOwner(archiveId, approved.id, true)))
        return { code: 403, error: "Доступ отозван" };
      await db.prepare("", `DELETE FROM discovery_branch_grants WHERE left_archive_id=?
        AND left_person_id=? AND right_archive_id=? AND right_person_id=?
        AND grantor_archive_id=?`).run(...pairArgs(pair), archiveId);
      return { code: 200 };
    });
    return result.code === 200 ? json(res, 200, { shared: false })
      : json(res, result.code, { error: result.error });
  };
}
