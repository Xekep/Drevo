/** Current archive originals, including local citation URLs without page suffixes.
 * Legacy pg.Client writers pass an explicit archive parameter because their
 * transaction must remain safe even where older tables lack archive RLS.
 */
function mediaReferencesSql(archiveParameter?: string) {
  const scope = (alias: string) => archiveParameter
    ? ` WHERE ${alias}.archive_id=${archiveParameter}`
    : "";
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
