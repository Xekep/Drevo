/** Current archive originals, including local citation URLs without page suffixes.
 * Legacy pg.Client writers pass an explicit archive parameter because their
 * transaction must remain safe even where older tables lack archive RLS.
 */
function mediaReferencesSql(archiveParameter?: string) {
  const scope = (alias: string) =>
    archiveParameter ? ` WHERE ${alias}.archive_id=${archiveParameter}` : "";
  return `
  SELECT p.data->>'photo' AS url FROM people p${scope("p")}
  UNION ALL SELECT p.data->>'url' FROM photos p${scope("p")}
  UNION ALL SELECT split_part(split_part(cited.value #>> '{}', '#', 1), '?', 1)
    FROM people p CROSS JOIN LATERAL jsonb_path_query(p.data, '$.**.sources[*].url') cited(value)${scope("p")}
  UNION ALL SELECT split_part(split_part(cited.value #>> '{}', '#', 1), '?', 1)
    FROM family_unions u CROSS JOIN LATERAL jsonb_path_query(u.data, '$.**.sources[*].url') cited(value)${scope("u")}
  UNION ALL SELECT split_part(split_part(cited.value #>> '{}', '#', 1), '?', 1)
    FROM relations r CROSS JOIN LATERAL jsonb_path_query(r.sources, '$[*].url') cited(value)${scope("r")}`;
}

export const postgresMediaReferencesSql = mediaReferencesSql();
export const scopedPostgresMediaReferencesSql = mediaReferencesSql("$1");

const claimNames = [
  "birthDateClaim",
  "deathDateClaim",
  "birthPlaceClaim",
  "deathPlaceClaim",
  "occupationClaim",
  "maidenNameClaim",
];
const personPaths = [
  "$.sources",
  ...claimNames.map((name) => `$.${name}.sources`),
  "$.awards[*].sources",
  "$.factAlternatives[*].sources",
  "$.events[*].sources",
  "$.events[*].dateClaim.sources",
  "$.events[*].placeClaim.sources",
  "$.events[*].alternatives[*].sources",
];
const unionPaths = [
  "$.sources",
  "$.formation.sources",
  "$.ending.sources",
  "$.divorce.sources",
  "$.ongoing.sources",
];
const pgSources = (object: string, paths: string[]) =>
  paths
    .map(
      (path) => `SELECT value FROM jsonb_path_query(${object}, '${path}[*]') AS citation(value)`,
    )
    .join(" UNION ALL ");
const sqliteArrayPrefix = "substr(j.fullkey,1,instr(j.fullkey,'[')-1)";
const sqliteArraySuffix = "substr(j.fullkey,instr(j.fullkey,']')+1)";
const sqlitePersonSources = `(j.fullkey IN ('$.sources',${claimNames.map((name) => `'$.${name}.sources'`).join(",")})
  OR (${sqliteArrayPrefix} IN ('$.awards','$.factAlternatives') AND ${sqliteArraySuffix}='.sources')
  OR (${sqliteArrayPrefix}='$.events' AND (${sqliteArraySuffix} IN ('.sources','.dateClaim.sources','.placeClaim.sources')
    OR (substr(${sqliteArraySuffix},1,instr(${sqliteArraySuffix},'[')-1)='.alternatives'
        AND substr(${sqliteArraySuffix},instr(${sqliteArraySuffix},']')+1)='.sources'))))`;

/** Exact supported citation slots, matching allCitations rather than arbitrary JSON URLs.
 * A catalog citation replaces its inline URL even when the catalog URL is empty.
 */
export const sqliteVisibleCitationMediaSql = `WITH request AS (SELECT ? AS visible_ids, ? AS url),
  citations AS (
    SELECT c.value AS citation FROM people p, request q, json_tree(p.data) j, json_each(CASE WHEN j.key='sources' AND j.type='array' THEN j.value ELSE '[]' END) c
      WHERE j.key='sources' AND j.type='array' AND ${sqlitePersonSources}
        AND (q.visible_ids IS NULL OR p.id IN (SELECT value FROM json_each(q.visible_ids)))
    UNION ALL SELECT c.value FROM people p, request q,json_each(p.data,'$.parentClaims') claim,json_each(claim.value,'$.sources') c
      WHERE (q.visible_ids IS NULL OR (p.id IN (SELECT value FROM json_each(q.visible_ids))
        AND json_extract(claim.value,'$.parentId') IN (SELECT value FROM json_each(q.visible_ids))))
    UNION ALL SELECT c.value FROM relations r, request q, json_each(r.sources) c
      WHERE r.type<>'spouse' AND (q.visible_ids IS NULL OR (r.source IN (SELECT value FROM json_each(q.visible_ids))
        AND r.target IN (SELECT value FROM json_each(q.visible_ids))))
    UNION ALL SELECT c.value FROM family_unions u, request q, json_tree(u.data) j,json_each(CASE WHEN j.key='sources' AND j.type='array' THEN j.value ELSE '[]' END) c
      WHERE j.key='sources' AND j.type='array' AND j.fullkey IN (${unionPaths.map((path) => `'${path}'`).join(",")})
        AND (q.visible_ids IS NULL OR (u.participant_a IN (SELECT value FROM json_each(q.visible_ids))
          AND u.participant_b IN (SELECT value FROM json_each(q.visible_ids))))
  ), resolved AS (
    SELECT c.citation, catalog.data AS catalog_data,
      CASE WHEN catalog.id IS NOT NULL THEN json_extract(catalog.data,'$.url') ELSE json_extract(c.citation,'$.url') END AS url
      FROM citations c LEFT JOIN source_catalog catalog ON catalog.id=json_extract(c.citation,'$.catalogId')
  ) SELECT citation,catalog_data FROM resolved r,request q
    WHERE substr(substr(r.url,1,instr(r.url||'#','#')-1),1,instr(substr(r.url,1,instr(r.url||'#','#')-1)||'?','?')-1)=q.url LIMIT 1`;

export const postgresVisibleCitationMediaSql = `WITH request AS (SELECT ?::jsonb AS visible_ids, ?::text AS url),
  citations AS (
    SELECT c.value AS citation FROM people p CROSS JOIN request q CROSS JOIN LATERAL (${pgSources("p.data", personPaths)}) c
      WHERE q.visible_ids IS NULL OR p.id IN (SELECT value FROM jsonb_array_elements_text(q.visible_ids))
    UNION ALL SELECT c.value FROM people p CROSS JOIN request q CROSS JOIN LATERAL jsonb_array_elements(COALESCE(p.data->'parentClaims','[]'::jsonb)) claim
      CROSS JOIN LATERAL jsonb_array_elements(COALESCE(claim.value->'sources','[]'::jsonb)) c
      WHERE q.visible_ids IS NULL OR (p.id IN (SELECT value FROM jsonb_array_elements_text(q.visible_ids))
        AND claim.value->>'parentId' IN (SELECT value FROM jsonb_array_elements_text(q.visible_ids)))
    UNION ALL SELECT c.value FROM relations r CROSS JOIN request q CROSS JOIN LATERAL jsonb_array_elements(r.sources::jsonb) c
      WHERE r.type<>'spouse' AND (q.visible_ids IS NULL OR (r.source IN (SELECT value FROM jsonb_array_elements_text(q.visible_ids))
        AND r.target IN (SELECT value FROM jsonb_array_elements_text(q.visible_ids))))
    UNION ALL SELECT c.value FROM family_unions u CROSS JOIN request q CROSS JOIN LATERAL (${pgSources("u.data", unionPaths)}) c
      WHERE q.visible_ids IS NULL OR (u.participant_a IN (SELECT value FROM jsonb_array_elements_text(q.visible_ids))
        AND u.participant_b IN (SELECT value FROM jsonb_array_elements_text(q.visible_ids)))
  ), resolved AS (
    SELECT c.citation, catalog.data AS catalog_data,
      CASE WHEN catalog.id IS NOT NULL THEN catalog.data->>'url' ELSE c.citation->>'url' END AS url
      FROM citations c LEFT JOIN source_catalog catalog ON catalog.archive_id=current_setting('drevo.archive_id') AND catalog.id=c.citation->>'catalogId'
  ) SELECT citation::text AS citation,catalog_data::text AS catalog_data FROM resolved r CROSS JOIN request q
    WHERE split_part(split_part(r.url,'#',1),'?',1)=q.url LIMIT 1`;
