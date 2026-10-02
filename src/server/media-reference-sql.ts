/** Current archive originals, including local citation URLs without page suffixes. */
export const postgresMediaReferencesSql = `
  SELECT data->>'photo' AS url FROM people
  UNION ALL SELECT data->>'url' FROM photos
  UNION ALL SELECT split_part(split_part(cited.value #>> '{}', '#', 1), '?', 1)
    FROM people p CROSS JOIN LATERAL jsonb_path_query(p.data, '$.**.sources[*].url') cited(value)
  UNION ALL SELECT split_part(split_part(cited.value #>> '{}', '#', 1), '?', 1)
    FROM family_unions u CROSS JOIN LATERAL jsonb_path_query(u.data, '$.**.sources[*].url') cited(value)
  UNION ALL SELECT split_part(split_part(cited.value #>> '{}', '#', 1), '?', 1)
    FROM relations r CROSS JOIN LATERAL jsonb_path_query(r.sources, '$[*].url') cited(value)`;
