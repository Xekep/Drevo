import { createHash } from "node:crypto";
import type { StoreDatabase } from "./store-database.ts";
import { candidateEvidence, candidateFuzzyTerms, candidateNameRoleQuery,
  candidatePlaceQueries } from "./discovery-candidate-ranking.ts";

type Row = Record<string, unknown>;
type Tier = 0 | 1 | 2 | 3 | 4;
type PageCursor = { v: 2; source: string; ignored: boolean; tier: Tier; key: string[] };
export const candidatePageSize = 24;
// The approximate tier remains intentionally partial rather than sorting an
// unbounded public projection; the cursor resumes after the last raw row.
export const candidateFuzzyScanLimit = 96;
// Every selected consent participates in the query or the caller must refine.
export const candidateRelativeClueLimit = 32;
export const candidateRelativeRowLimit = 128;
const givenKey = (alias: string) => `replace(lower(coalesce(nullif(${alias}.given_part,''),
  split_part(${alias}.name,' ',2))), 'ё', 'е')`;
const surnameKey = (alias: string) => `replace(lower(coalesce(nullif(${alias}.surname_part,''),
  split_part(${alias}.name,' ',1))), 'ё', 'е')`;
const fields = `d.archive_id,d.person_id,d.name,d.surname_part,d.given_part,d.birth_surname,
  d.birth_year,d.death_year,d.birth_place,d.death_place,
  d.publication_version::text AS publication_version,d.xmin::text AS row_version`;
const exactOrder = `coalesce(d.birth_year,'9999'),d.name COLLATE "C",
  d.archive_id COLLATE "C",d.person_id COLLATE "C"`;

function published(row: Row) {
  return { name: String(row.name),
    ...(row.surname_part != null ? { surname: String(row.surname_part) } : {}),
    ...(row.given_part != null ? { givenName: String(row.given_part) } : {}),
    ...(row.birth_surname ? { birthSurname: String(row.birth_surname) } : {}),
    ...(row.birth_year ? { birthYear: String(row.birth_year) } : {}),
    ...(row.death_year ? { deathYear: String(row.death_year) } : {}),
    ...(row.birth_place ? { birthPlace: String(row.birth_place) } : {}),
    ...(row.death_place ? { deathPlace: String(row.death_place) } : {}),
  };
}

export function decodeCandidatePageCursor(value: string | null): PageCursor | null | false {
  if (!value) return null;
  if (value.length > 1800) return false;
  try {
    const parsed: unknown = JSON.parse(Buffer.from(value, "base64url").toString("utf8"));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return false;
    const item = parsed as Partial<PageCursor>;
    if (item.v !== 2 || typeof item.source !== "string" || !/^[a-f0-9]{64}$/.test(item.source) ||
        typeof item.ignored !== "boolean" || typeof item.tier !== "number" ||
        ![0,1,2,3,4].includes(item.tier) ||
        !Array.isArray(item.key) || item.key.length > 4 ||
        !item.key.every((part) => typeof part === "string" && part.length <= 512)) return false;
    const size = item.tier === 0 ? 2 : item.tier === 4 ? 3 : 4;
    return item.key.length === 0 || item.key.length === size ? item as PageCursor : false;
  } catch { return false; }
}

const encodeCursor = (value: PageCursor) => Buffer.from(JSON.stringify(value)).toString("base64url");
const exactKey = (row: Row) => [String(row.sort_birth),String(row.name),
  String(row.archive_id),String(row.person_id)];
const relativeKey = (row: Row) => [String(row.archive_id),String(row.person_id)];
const fuzzyKey = (row: Row) => [String(row.name),String(row.archive_id),String(row.person_id)];

export async function discoveryCandidatePage(db: StoreDatabase, input: {
  archiveId: string; sourceId: string; sourceRow: Row; ignored: boolean;
  cursor: PageCursor | null;
}): Promise<{ kind: "stale" } | { kind: "refine" } | { kind: "page";
  rows: Row[]; relatives: { people: { archive_id: string; person_id: string }[]; signals: Row[] };
  candidates: { archiveId: string; id: string; name: string; birthSurname?: string;
    birthYear?: string; deathYear?: string; birthPlace?: string; deathPlace?: string;
    reasons: string[]; conflicts: string[] }[];
  nextCursor: string | null; approximate: boolean; partial: boolean;
}> {
  const { archiveId, sourceId, sourceRow, ignored } = input;
  const source = published(sourceRow);
  const given = String(sourceRow.given_key || "");
  const currentSurname = String(sourceRow.surname_key || "");
  const birthSurname = String(sourceRow.birth_surname_key || "");
  const surnames = [...new Set([currentSurname,birthSurname]
    .map((part) => String(part || "")).filter(Boolean))];
  // Either published surname role may match either role on the other card.
  // The UNION in exactRows removes a person matched through multiple roles.
  const surnameComparisons = surnames.flatMap((value) => [
    { column: surnameKey("d"), value },
    { column: "d.birth_surname_normalized", value },
  ]);
  const birth = String(sourceRow.birth_year || "");
  const relativeRows = await db.prepare("", `SELECT first_relation_id,second_relation_id,
    kind,relative_name_key,row_version FROM discovery_candidate_relative_consents
    WHERE archive_id=? AND person_id=?
    ORDER BY kind COLLATE "C",first_relation_id COLLATE "C",
      second_relation_id COLLATE "C" NULLS FIRST
    LIMIT ${candidateRelativeRowLimit + 1}`)
    .all(archiveId,sourceId);
  const clues = [...new Map(relativeRows.map((row) =>
    [`${row.kind}:${row.relative_name_key}`, { kind: String(row.kind),
      key: String(row.relative_name_key) }])).values()];
  if (relativeRows.length > candidateRelativeRowLimit || clues.length > candidateRelativeClueLimit)
    return { kind: "refine" };
  const sourceFingerprint = createHash("sha256").update(JSON.stringify([
    archiveId,sourceId,ignored,sourceRow.name,sourceRow.surname_part,sourceRow.given_part,
    sourceRow.birth_surname,sourceRow.birth_year,sourceRow.death_year,sourceRow.birth_place,
    sourceRow.death_place,sourceRow.publication_version,sourceRow.row_version,relativeRows,
  ])).digest("hex");
  if (input.cursor && (input.cursor.source !== sourceFingerprint ||
      input.cursor.ignored !== ignored)) return { kind: "stale" };
  const withCursor = (tier: Tier, key: string[]) => encodeCursor({
    v: 2, source: sourceFingerprint, ignored, tier, key,
  });
  const filter = `d.archive_id<>? AND NOT EXISTS (SELECT 1 FROM discovery_ignored_archives a
    WHERE a.archive_id=? AND a.target_archive_id=d.archive_id)
    AND ${ignored ? "EXISTS" : "NOT EXISTS"} (SELECT 1 FROM discovery_ignored_candidates i
      WHERE i.archive_id=? AND i.source_person_id=? AND i.target_archive_id=d.archive_id
        AND i.target_person_id=d.person_id)
    AND NOT EXISTS (SELECT 1 FROM discovery_match_requests m
      WHERE m.status IN ('pending','linked') AND ((m.left_archive_id=? AND m.left_person_id=?
        AND m.right_archive_id=d.archive_id AND m.right_person_id=d.person_id)
        OR (m.right_archive_id=? AND m.right_person_id=?
          AND m.left_archive_id=d.archive_id AND m.left_person_id=d.person_id)))`;
  const filterArgs = [archiveId,archiveId,archiveId,sourceId,archiveId,sourceId,
    archiveId,sourceId];
  const clueJson = JSON.stringify(clues);
  const relativeExists = `EXISTS (SELECT 1 FROM discovery_candidate_relative_consents c
    JOIN jsonb_to_recordset(?::jsonb) AS s(kind text,key text)
      ON s.kind=c.kind AND s.key=c.relative_name_key
    WHERE c.archive_id=d.archive_id AND c.person_id=d.person_id)`;
  const relativeEnabled = clues.length > 0 && given.length >= 2 && /^\d{4}$/.test(birth);
  const bounded = (sql: string, values: string[], milliseconds: 500 | 2000) =>
    db.transaction(async () => {
      await db.exec("", `SET LOCAL statement_timeout='${milliseconds}ms'`);
      return db.prepare("",sql).all(...values);
    }, true);
  const after = input.cursor?.key || [];
  const selected: Row[] = [];
  let nextCursor: string | null = null;
  let approximate = false;
  let partial = false;
  let fuzzyRows: Row[] = [];

  const exactRows = async (tier: 1 | 2 | 3, key: string[], limit: number) => {
    if (!given || !surnames.length || (tier < 3 && !birth)) return [];
    const branches: string[] = [], args: string[] = [];
    for (const { column, value } of surnameComparisons) {
      const lower = String(Math.max(1,Number(birth)-2)).padStart(4,"0");
      const upper = String(Math.min(9999,Number(birth)+2)).padStart(4,"0");
      const yearSql = tier === 1 ? "coalesce(d.birth_year,'9999')=?" : tier === 2
        ? "coalesce(d.birth_year,'9999') BETWEEN ? AND ? AND d.birth_year<>?" : birth
          ? "(coalesce(d.birth_year,'9999')<? OR coalesce(d.birth_year,'9999')>?)" : "true";
      const yearArgs = tier === 1 ? [birth] : tier === 2 ? [lower,upper,birth] :
        birth ? [lower,upper] : [];
      const skipRelative = relativeEnabled
        ? `AND (d.birth_year BETWEEN ? AND ? AND ${relativeExists}) IS NOT TRUE` : "";
      branches.push(`(SELECT ${fields},coalesce(d.birth_year,'9999') AS sort_birth
        FROM discovery_people d WHERE ${givenKey("d")}=? AND ${column}=? AND ${yearSql}
          AND (${exactOrder}) > (?,?,?,?) AND ${filter} ${skipRelative}
        ORDER BY ${exactOrder} LIMIT ${limit})`);
      args.push(given,value,...yearArgs,
        ...(key.length ? key : ["","","",""]),...filterArgs,
        ...(relativeEnabled ? [lower,upper,clueJson] : []));
    }
    if (!branches.length) return [];
    return bounded(`WITH streams AS (${branches.join(" UNION ")})
      SELECT * FROM streams ORDER BY sort_birth,name COLLATE "C",
        archive_id COLLATE "C",person_id COLLATE "C" LIMIT ${limit}`,args,2000);
  };

  const relativeRowsFor = async (key: string[], limit: number) => {
    if (!relativeEnabled) return [];
    const lower = String(Math.max(1,Number(birth)-2)).padStart(4,"0");
    const upper = String(Math.min(9999,Number(birth)+2)).padStart(4,"0");
    return bounded(`WITH clues AS (
      SELECT * FROM jsonb_to_recordset(?::jsonb) AS s(kind text,key text)
    ), per_clue AS (
      SELECT found.* FROM clues s CROSS JOIN LATERAL (
        SELECT DISTINCT ON (c.archive_id COLLATE "C",c.person_id COLLATE "C") ${fields}
        FROM discovery_candidate_relative_consents c JOIN discovery_people d
          ON d.archive_id=c.archive_id AND d.person_id=c.person_id
        WHERE c.kind=s.kind AND c.relative_name_key=s.key
          AND (c.archive_id COLLATE "C",c.person_id COLLATE "C") > (?,?)
          AND ${givenKey("d") }=? AND d.birth_year BETWEEN ? AND ?
          AND ${filter}
        ORDER BY c.archive_id COLLATE "C",c.person_id COLLATE "C",
          c.kind COLLATE "C",c.first_relation_id COLLATE "C",
          c.second_relation_id COLLATE "C" NULLS FIRST
        LIMIT ${limit}
      ) found
    ) SELECT DISTINCT ON (archive_id COLLATE "C",person_id COLLATE "C") * FROM per_clue
      ORDER BY archive_id COLLATE "C",person_id COLLATE "C" LIMIT ${limit}`,
      [clueJson,...(key.length ? key : ["",""]),given,lower,upper,...filterArgs],2000);
  };

  const fuzzy = async (key: string[]) => {
    const branches: string[] = [], args: string[] = [];
    const exact = candidateNameRoleQuery(source), typo = candidateFuzzyTerms(source);
    const places = candidatePlaceQueries(source);
    if (exact) {
      branches.push(`SELECT archive_id,person_id FROM discovery_people
        WHERE archive_id<>? AND name_vector @@ to_tsquery('simple',?)
          AND to_tsvector('simple', replace(lower(coalesce(nullif(given_part,''),
            split_part(name,' ',2))), 'ё','е')) @@ to_tsquery('simple',?)
          AND to_tsvector('simple', replace(lower(coalesce(nullif(surname_part,''),
            split_part(name,' ',1)) || ' ' || coalesce(birth_surname,'')), 'ё','е'))
              @@ to_tsquery('simple',?)`);
      args.push(archiveId,exact.name,exact.given,exact.surname);
    }
    if (typo) {
      branches.push(`SELECT archive_id,person_id FROM discovery_people
        WHERE archive_id<>? AND given_normalized % ? AND (${
          typo.surnames.map(() => `(surname_normalized % ? OR birth_surname_normalized % ?)`)
            .join(" OR ")})`);
      args.push(archiveId,typo.given,...typo.surnames.flatMap((part) => [part,part]));
    }
    for (const place of places) {
      const column = place.field === "birthPlace" ? "birth_place" : "death_place";
      branches.push(`SELECT archive_id,person_id FROM discovery_people
        WHERE archive_id<>? AND search_vector @@ to_tsquery('simple',?)
          AND to_tsvector('simple', replace(lower(coalesce(${column},'')), 'ё','е'))
              @@ to_tsquery('simple',?) AND birth_year BETWEEN ? AND ?`);
      args.push(archiveId,place.terms,place.locality,place.from,place.to);
    }
    if (!branches.length) return [];
    const exactExclusion = surnames.length ? `AND (${givenKey("d") }=? AND (${
      surnameComparisons.map(({ column }) => `${column}=?`).join(" OR ")})) IS NOT TRUE` : "";
    const relativeExclusion = relativeEnabled ? `AND (${givenKey("d") }=?
      AND d.birth_year BETWEEN ? AND ? AND ${relativeExists}) IS NOT TRUE` : "";
    const sql = `WITH candidate_keys AS (${branches.join(" UNION ")})
      SELECT ${fields} FROM discovery_people d JOIN candidate_keys k
        ON k.archive_id=d.archive_id AND k.person_id=d.person_id
      WHERE (d.name COLLATE "C",d.archive_id COLLATE "C",d.person_id COLLATE "C")
        > (?,?,?) AND ${filter} ${exactExclusion} ${relativeExclusion}
      ORDER BY d.name COLLATE "C",d.archive_id COLLATE "C",d.person_id COLLATE "C"
      LIMIT ${candidateFuzzyScanLimit + 1}`;
    const values = [...args,...(key.length ? key : ["","",""]),...filterArgs,
      ...(surnames.length ? [given,...surnameComparisons.map(({ value }) => value)] : []),
      ...(relativeEnabled ? [given,
        String(Math.max(1,Number(birth)-2)).padStart(4,"0"),
        String(Math.min(9999,Number(birth)+2)).padStart(4,"0"),clueJson] : [])];
    return bounded(sql,values,500);
  };

  const relativesFor = async (found: Row[]) => {
    const people = [sourceRow,...found].map((row) => ({
      archive_id: String(row.archive_id),person_id: String(row.person_id),
    }));
    const signals = await db.prepare("", `SELECT c.archive_id,c.person_id,
      c.first_relation_id,c.second_relation_id,c.via_person_id,c.relative_person_id,
      c.kind,c.relative_name,c.row_version
      FROM discovery_candidate_relative_consents c JOIN jsonb_to_recordset(?::jsonb)
        AS p(archive_id text,person_id text)
        ON p.archive_id=c.archive_id AND p.person_id=c.person_id
      ORDER BY c.archive_id COLLATE "C",c.person_id COLLATE "C",
        c.kind COLLATE "C",c.first_relation_id COLLATE "C",
        c.second_relation_id COLLATE "C" NULLS FIRST`).all(JSON.stringify(people));
    return { people,signals };
  };
  let candidateRelatives: Awaited<ReturnType<typeof relativesFor>> | null = null;
  const relativesOf = (row: Row) => (candidateRelatives?.signals || [])
    .filter((signal) => signal.archive_id === row.archive_id &&
      signal.person_id === row.person_id)
    .map((signal) => ({ kind: String(signal.kind) as "parent" | "child" | "spouse" | "grandparent",
      name: String(signal.relative_name) }));
  const evidence = new Map<string, ReturnType<typeof candidateEvidence>>();
  let tier: Tier = input.cursor?.tier ?? 0;
  for (; tier <= 4 && selected.length < candidatePageSize; tier = (tier + 1) as Tier) {
    const key = input.cursor?.tier === tier ? after : [];
    const remaining = candidatePageSize - selected.length;
    if (tier === 4) {
      approximate = true;
      fuzzyRows = await fuzzy(key);
      candidateRelatives = await relativesFor([...selected,...fuzzyRows]);
      const scan = fuzzyRows.slice(0,candidateFuzzyScanLimit);
      let consumed = 0;
      for (const row of scan) {
        consumed++;
        const value = candidateEvidence(source,published(row),relativesOf(sourceRow),
          relativesOf(row));
        if (!value) continue;
        selected.push(row);
        evidence.set(`${row.archive_id}:${row.person_id}`,value);
        if (selected.length === candidatePageSize) break;
      }
      partial = fuzzyRows.length > consumed;
      if (partial) nextCursor = withCursor(4,fuzzyKey(fuzzyRows[consumed - 1]));
      break;
    }
    const rows = tier === 0 ? await relativeRowsFor(key,remaining + 1)
      : await exactRows(tier as 1 | 2 | 3,key,remaining + 1);
    selected.push(...rows.slice(0,remaining));
    if (rows.length > remaining) {
      const last = selected.at(-1)!;
      nextCursor = withCursor(tier,tier === 0 ? relativeKey(last) : exactKey(last));
      break;
    }
    if (selected.length === candidatePageSize) {
      nextCursor = tier < 4 ? withCursor((tier + 1) as Tier,[]) : null;
      break;
    }
  }
  const relatives = await relativesFor(selected);
  candidateRelatives = relatives;
  const candidates = selected.map((row) => {
    const person = published(row);
    const found = evidence.get(`${row.archive_id}:${row.person_id}`) ||
      candidateEvidence(source,person,relativesOf(sourceRow),relativesOf(row));
    if (!found) throw new Error("Indexed discovery tier returned a candidate without evidence");
    return { archiveId: String(row.archive_id),id: String(row.person_id),...person,
      reasons: found.reasons,conflicts: found.conflicts };
  });
  return { kind: "page",rows: selected,relatives,candidates,nextCursor,
    approximate,partial };
}
