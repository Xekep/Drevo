import { isDeepStrictEqual } from "node:util";
import type pg from "pg";
import type { Family } from "../domain/types.ts";
import { archiveRows } from "./archive-rows.ts";

export async function persistPostgresGraphChanges(
  client: pg.Client,
  archiveId: string,
  before: Family,
  after: Family,
) {
  await client.query("SELECT set_config('drevo.archive_id',$1,true)", [
    archiveId,
  ]);
  const previous = archiveRows(before),
    next = archiveRows(after);
  const oldPeople = new Map(
    previous.people.map((row) => [row.id, JSON.parse(row.data)]),
  );
  let ordinal = Number(
    (
      await client.query(
        "SELECT COALESCE(MAX(ordinal),0) AS ordinal FROM people WHERE archive_id=$1",
        [archiveId],
      )
    ).rows[0].ordinal,
  );
  for (const row of next.people) {
    if (!oldPeople.has(row.id)) {
      await client.query(
        "INSERT INTO people(archive_id,id,ordinal,data) VALUES($1,$2,$3,$4::jsonb)",
        [archiveId, row.id, ++ordinal, row.data],
      );
    } else if (
      !isDeepStrictEqual(oldPeople.get(row.id), JSON.parse(row.data))
    ) {
      await client.query(
        "UPDATE people SET data=$3::jsonb WHERE archive_id=$1 AND id=$2",
        [archiveId, row.id, row.data],
      );
    }
  }
  const unionRows = await client.query(
    "SELECT id,ordinal,participant_a,participant_b,data FROM family_unions WHERE archive_id=$1 ORDER BY ordinal",
    [archiveId],
  );
  const oldUnions = new Map(unionRows.rows.map((row) => [String(row.id), row]));
  const nextUnions = new Set(next.unions.map((row) => row.id));
  for (const row of unionRows.rows)
    if (!nextUnions.has(String(row.id)))
      await client.query(
        "DELETE FROM family_unions WHERE archive_id=$1 AND id=$2",
        [archiveId, row.id],
      );
  const reorderUnions = unionRows.rows.some(
    (row, index) => next.unions[index]?.id !== row.id,
  );
  if (reorderUnions)
    await client.query(
      "UPDATE family_unions SET ordinal=-ordinal WHERE archive_id=$1",
      [archiveId],
    );
  for (const [index, row] of next.unions.entries()) {
    const old = oldUnions.get(row.id);
    if (
      !old ||
      old.participant_a !== row.participantA ||
      old.participant_b !== row.participantB ||
      !isDeepStrictEqual(old.data, JSON.parse(row.data)) ||
      reorderUnions ||
      Number(old.ordinal) !== index + 1
    )
      await client.query(
        `INSERT INTO family_unions(archive_id,id,ordinal,participant_a,participant_b,data)
         VALUES($1,$2,$3,$4,$5,$6::jsonb)
         ON CONFLICT (archive_id,id) DO UPDATE SET ordinal=EXCLUDED.ordinal,
         participant_a=EXCLUDED.participant_a,participant_b=EXCLUDED.participant_b,data=EXCLUDED.data`,
        [
          archiveId,
          row.id,
          index + 1,
          row.participantA,
          row.participantB,
          row.data,
        ],
      );
  }
  // Preserve existing marriage order when adding another spouse. Parent and
  // extra-link order follows the requested graph. Only changed rows are touched;
  // changes use a temporary negative range to avoid immediate UNIQUE collisions.
  const oldRows = (
    await client.query(
      "SELECT id,ordinal,source,target,type,note,twin_kind,created_by,sources,confidence FROM relations WHERE archive_id=$1 ORDER BY ordinal",
      [archiveId],
    )
  ).rows;
  const old = new Map(oldRows.map((row) => [String(row.id), row]));
  const rows = next.relations.map((row) => ({
    id: row.id,
    source: row.source,
    target: row.target,
    type: row.type,
    note: row.note,
    twin_kind: row.twinKind,
    created_by: row.createdBy,
    sources: JSON.parse(row.sources),
    confidence: row.confidence,
  }));
  const nextById = new Map(rows.map((row) => [row.id, row]));
  const kind = (row: { type: string }) =>
    row.type === "parent"
      ? "parent"
      : row.type === "spouse"
        ? "spouse"
        : "extra";
  const retainedSpouses = oldRows.filter(
    (row) => row.type === "spouse" && nextById.get(row.id)?.type === "spouse",
  );
  const retainedIds = new Set(retainedSpouses.map((row) => row.id));
  const streams = {
    parent: rows.filter((row) => row.type === "parent"),
    spouse: [
      ...retainedSpouses.map((row) => nextById.get(row.id)!),
      ...rows.filter(
        (row) => row.type === "spouse" && !retainedIds.has(row.id),
      ),
    ],
    extra: rows.filter((row) => kind(row) === "extra"),
  };
  const positions = { parent: 0, spouse: 0, extra: 0 };
  const ordered: typeof rows = [];
  for (const row of oldRows) {
    const group = kind(row);
    const replacement = streams[group][positions[group]++];
    if (replacement) ordered.push(replacement);
  }
  for (const group of ["parent", "spouse", "extra"] as const)
    ordered.push(...streams[group].slice(positions[group]));
  const desired = ordered.map((row, index) => ({ ...row, ordinal: index + 1 }));
  // One undirected relation has one order in SQL. Return exactly the spouse
  // lists a subsequent read hydrates, including batches with several marriages.
  const persisted = structuredClone(after);
  const people = new Map(persisted.people.map((p) => [p.id, p]));
  for (const p of persisted.people) p.spouses = [];
  for (const row of desired)
    if (row.type === "spouse") {
      people.get(row.source)!.spouses.push(row.target);
      people.get(row.target)!.spouses.push(row.source);
    }
  const byId = new Map(desired.map((row) => [row.id, row]));
  const removed = oldRows
    .filter((row) => {
      const target = byId.get(row.id);
      return (
        !target ||
        target.source !== row.source ||
        target.target !== row.target ||
        target.type !== row.type
      );
    })
    .map((row) => String(row.id));
  if (removed.length)
    await client.query(
      "DELETE FROM relations WHERE archive_id=$1 AND id=ANY($2::text[])",
      [archiveId, removed],
    );
  const moved = desired
    .filter(
      (row) =>
        old.has(row.id) && Number(old.get(row.id)!.ordinal) !== row.ordinal,
    )
    .map((row) => row.id);
  if (moved.length)
    await client.query(
      "UPDATE relations SET ordinal=-ordinal-1 WHERE archive_id=$1 AND id=ANY($2::text[])",
      [archiveId, moved],
    );
  const changed = desired.filter(
    (row) =>
      !isDeepStrictEqual(
        { ...old.get(row.id), ordinal: Number(old.get(row.id)?.ordinal) },
        row,
      ),
  );
  if (changed.length)
    await client.query(
      `INSERT INTO relations(archive_id,id,ordinal,source,target,type,note,twin_kind,created_by,sources,confidence)
     SELECT $1,r.id,r.ordinal,r.source,r.target,r.type,r.note,r.twin_kind,r.created_by,r.sources,r.confidence
       FROM jsonb_to_recordset($2::jsonb) AS r(id text,ordinal bigint,source text,target text,type text,note text,twin_kind text,created_by text,sources jsonb,confidence text)
     ON CONFLICT (archive_id,id) DO UPDATE SET ordinal=EXCLUDED.ordinal,source=EXCLUDED.source,
       target=EXCLUDED.target,type=EXCLUDED.type,note=EXCLUDED.note,twin_kind=EXCLUDED.twin_kind,created_by=EXCLUDED.created_by,sources=EXCLUDED.sources,confidence=EXCLUDED.confidence`,
      [archiveId, JSON.stringify(changed)],
    );
  const remaining = new Set(next.people.map((row) => row.id));
  const deleted = previous.people
    .filter((row) => !remaining.has(row.id))
    .map((row) => row.id);
  if (deleted.length)
    await client.query(
      "DELETE FROM people WHERE archive_id=$1 AND id=ANY($2::text[])",
      [archiveId, deleted],
    );
  return persisted;
}
