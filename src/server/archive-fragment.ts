import type { openArchive } from "./database.ts";
import { readArchiveOverview } from "./database.ts";
import { familyNeighbors } from "../domain/family-neighborhood.ts";
import { treeFragment, FRAGMENT_PEOPLE_LIMIT } from "../domain/tree-fragment.ts";
import { projectFamilyToVisibleIds, isScopedUser } from "../domain/tree-access.ts";
import type { ArchiveUser } from "../domain/access.ts";
import type { Person, FamilyLink, FamilyUnion } from "../domain/types.ts";
import type { ArchiveTreeFragment, TreeFragmentRequest } from "../shared/tree-fragment.ts";
import { publicPersonId } from "./public-person-id.ts";
import { isTreeGenerationLimits } from "../domain/tree-preferences.ts";
import { createKinshipAnalyzer } from "../domain/kinship-analysis.ts";
import { kinshipRelationLabel } from "../domain/kinship-label.ts";
import { resolvedSex } from "../domain/name-hints.ts";

type Archive = Awaited<ReturnType<typeof openArchive>>;
type Topology = { revision: number; people: Person[]; links: FamilyLink[]; unions: FamilyUnion[] };

export function parseTreeFragmentRequest(value: unknown): TreeFragmentRequest {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Некорректный фрагмент");
  const input = value as Record<string, unknown>;
  if (Object.keys(input).some(key => !["anchorId", "ancestors", "descendants", "collateral", "expanded", "offset", "previous"].includes(key)) ||
      !publicPersonId(input.anchorId) ||
      !isTreeGenerationLimits({ anchorId: input.anchorId, ancestors: input.ancestors, descendants: input.descendants, collateral: input.collateral }) ||
      (input.offset !== undefined && (!Number.isSafeInteger(input.offset) || Number(input.offset) < 0 || Number(input.offset) > 100_000)) ||
      [input.expanded, input.previous].some(ids => ids !== undefined && (!Array.isArray(ids) || ids.length > FRAGMENT_PEOPLE_LIMIT || !ids.every(publicPersonId) || new Set(ids).size !== ids.length)))
    throw new Error("Некорректный фрагмент");
  return input as TreeFragmentRequest;
}

/** IDs/edges/resolved sex are indexed archive-wide; unknown-sex name hints are
 * transient. Complete overview rows are selected for at most 500 people.
 * The existing runtime byte budget owns this derived index.
 */
export function archiveFragmentReader(archive: Archive) {
  const key = Symbol("tree fragment topology");
  const loadTopology = async (): Promise<Topology> => {
    const meta = await archive.meta();
    const cached = archive.cacheBudget.getDerived<Topology>(key);
    if (cached?.revision === meta.revision) return cached;
    const people = (await archive.db.prepare(
      `SELECT id,json_extract(data,'$.sex') AS sex,json_extract(data,'$.parentageComplete') AS complete,
        CASE WHEN coalesce(json_extract(data,'$.sex'),'u') NOT IN ('m','f') THEN json_extract(data,'$.name') END AS hint_name,
        CASE WHEN coalesce(json_extract(data,'$.sex'),'u') NOT IN ('m','f') THEN json_extract(data,'$.patronymic') END AS hint_patronymic FROM people ORDER BY rowid`,
      `SELECT id,data->>'sex' AS sex,data->>'parentageComplete' AS complete,
        CASE WHEN coalesce(data->>'sex','u') NOT IN ('m','f') THEN data->>'name' END AS hint_name,
        CASE WHEN coalesce(data->>'sex','u') NOT IN ('m','f') THEN data->>'patronymic' END AS hint_patronymic FROM people ORDER BY ordinal`,
    ).all()).map(row => ({
      // Legacy unknown-sex rows use the same name hints as the client. Names
      // are discarded here; the cached topology retains only the resolved sex.
      id: String(row.id), name: "", surname: "", patronymic: "", sex: resolvedSex({
        sex: row.sex === "m" || row.sex === "f" ? row.sex : "u",
        name: String(row.hint_name || ""), patronymic: String(row.hint_patronymic || ""),
      }),
      ...(row.complete === true || row.complete === 1 || row.complete === "true" ? { parentageComplete: true }
        : row.complete === false || row.complete === 0 || row.complete === "false" ? { parentageComplete: false } : {}),
      birth: "", birthPlace: "", generation: 1, column: 0, sources: [], parents: [] as string[], spouses: [] as string[],
    }));
    const byId = new Map(people.map(person => [person.id, person]));
    const links: FamilyLink[] = [];
    for (const row of await archive.db.prepare(
      "SELECT id,source,target,type,twin_kind FROM relations ORDER BY rowid",
      "SELECT id,source,target,type,twin_kind FROM relations ORDER BY ordinal",
    ).all()) {
      const a = byId.get(String(row.source)), b = byId.get(String(row.target));
      if (!a || !b) continue;
      if (row.type === "parent") b.parents.push(a.id);
      else if (row.type === "spouse") { a.spouses.push(b.id); b.spouses.push(a.id); }
      else links.push({ id: String(row.id), from: a.id, to: b.id, type: row.type as FamilyLink["type"],
        ...(row.twin_kind ? { twinKind: row.twin_kind as FamilyLink["twinKind"] } : {}) });
    }
    const milestones = ["formation", "ending", "divorce", "ongoing"] as const;
    const unions: FamilyUnion[] = (await archive.db.prepare(
      `SELECT id,participant_a,participant_b,json_extract(data,'$.type') AS type,${milestones.map(field =>
        `(json_type(data,'$.${field}')='object') AS has_${field},json_extract(data,'$.${field}.date') AS ${field}_date`).join(",")} FROM family_unions ORDER BY rowid`,
      `SELECT id,participant_a,participant_b,data->>'type' AS type,${milestones.map(field =>
        `(jsonb_typeof(data->'${field}')='object') AS has_${field},data->'${field}'->>'date' AS ${field}_date`).join(",")} FROM family_unions ORDER BY ordinal`,
    ).all()).map(row => ({ id: String(row.id), participants: [String(row.participant_a), String(row.participant_b)] as [string, string],
      type: row.type as FamilyUnion["type"], ...Object.fromEntries(milestones.flatMap(field => row[`has_${field}`]
        ? [[field, row[`${field}_date`] ? { date: String(row[`${field}_date`]) } : {}]] : [])) }));
    const topology = { revision: meta.revision, people, links, unions };
    archive.cacheBudget.setDerived(key, topology, JSON.stringify(topology).length * 4);
    return topology;
  };
  return {
    async anchor(actor: ArchiveUser | null, preferred?: string) {
      return archive.db.transaction(async () => {
        const topology = await loadTopology();
        const visible = isScopedUser(actor) ? await archive.visibleIds(actor) : new Set(topology.people.map(person => person.id));
        return preferred && visible.has(preferred) ? preferred
          : actor?.personId && visible.has(actor.personId) ? actor.personId : visible.values().next().value;
      }, true);
    },
    async read(request: TreeFragmentRequest, actor: ArchiveUser | null) {
      const prepared = await archive.db.transaction(async () => {
        const topology = await loadTopology();
        const visible = isScopedUser(actor) ? await archive.visibleIds(actor) : new Set(topology.people.map(person => person.id));
        // Unauthorized and missing anchors are deliberately indistinguishable.
        if (!visible.has(request.anchorId)) return null;
        if (request.expanded?.some(id => !visible.has(id))) return null;
        if (request.previous?.some(id => !visible.has(id))) return null;
        const allowed = projectFamilyToVisibleIds({ title: "", description: "", demo: false, ...topology }, visible, actor?.id || "");
        const index = familyNeighbors(allowed);
        const adjacent = [...(index.neighbors.get(request.anchorId) || [])].filter(id => visible.has(id));
        const offset = adjacent.length ? (request.offset || 0) % adjacent.length : 0;
        const ordered = [...adjacent.slice(offset), ...adjacent.slice(0, offset)];
        const previous = new Set(request.previous);
        const priority = offset || previous.size ? [...ordered.filter(id => !previous.has(id)), ...ordered.filter(id => previous.has(id))] : [];
        const projection = treeFragment(index, visible, request, new Set(request.expanded), FRAGMENT_PEOPLE_LIMIT, priority);
        const selected = await readArchiveOverview(archive.db, true, projection.visible);
        const family = projectFamilyToVisibleIds(selected.family, projection.visible, actor?.id || "");
        const state: ArchiveTreeFragment = {
          anchorId: request.anchorId, ancestors: request.ancestors, descendants: request.descendants, collateral: request.collateral,
          offset, expanded: request.expanded || [], hidden: [...projection.hidden],
          atLimit: projection.atLimit,
          nextOffset: adjacent.length ? (offset + Math.max(1, [...projection.visible].filter(id => adjacent.includes(id)).length)) % adjacent.length : 0,
          total: visible.size,
          peopleIds: [...projection.visible],
        };
        return { response: { ...selected, family, fragment: state, totals: { people: visible.size,
          photos: isScopedUser(actor) ? await archive.photoCount({ visible, userId: actor.id }) : selected.totals.photos } }, allowed };
      }, true);
      if (!prepared) return null;
      const { response, allowed } = prepared;
      const reference = actor?.personId ? allowed.people.find(person => person.id === actor.personId) : undefined;
      if (reference) {
        // One analyzer for the authorized topology, outside the SQL transaction.
        // Return bounded labels only; paths/names of omitted people stay private.
        const analyze = createKinshipAnalyzer(allowed.people, allowed.links, allowed.unions);
        const byId = new Map(allowed.people.map(person => [person.id, person]));
        response.fragment.referenceId = reference.id;
        response.fragment.relationLabels = Object.fromEntries(response.fragment.peopleIds.map(id => {
          if (id === reference.id) return [id, "Это вы"];
          const relation = analyze(byId.get(id)!, reference);
          return [id, kinshipRelationLabel(relation)];
        }));
      }
      return response;
    },
    close() { archive.cacheBudget.remove(key); },
  };
}
