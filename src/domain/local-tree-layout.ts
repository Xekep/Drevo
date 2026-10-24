import type { LayoutPerson, TreeGeometry } from "./tree-layout.ts";
import type { FamilyLink } from "./types.ts";
import { householdLevels } from "./household-levels.ts";
import { familyUnions, type UnionBranch } from "./union-layout.ts";
import { groupFamilyUnions, localUnionRoutes } from "./union-groups.ts";
import { FAMILY_DISPLAY_GAP, MAX_LOCAL_LAYOUT_PEOPLE, type TreeNodeSize } from "./tree-layout-constants.ts";
import { bounds, segmentContact, segmentHitsBox, simplifyRoute } from "./edge-routing.ts";
import { localFamilyGrowth, MAX_LOCAL_FAMILY_ADDITIONS } from "./local-family-growth.ts";
import { GENERATION_DEVIATION } from "./generation-bands.ts";

export type LocalLayoutInput = { people: LayoutPerson[]; links: Pick<FamilyLink, "type" | "from" | "to">[] };
export type LocalLayoutResult = { geometry: TreeGeometry; kind: "retained" | "local" };

const relations = (p: LayoutPerson) => JSON.stringify([p.id, p.parents, p.spouses]);

/** A conservative fast path. Ambiguous unions, changed ranks and unsafe routes use the full solver. */
export function localTreeLayout(
  input: LocalLayoutInput, previousInput: LocalLayoutInput, previous: TreeGeometry,
  size: TreeNodeSize,
): LocalLayoutResult | undefined {
  if (previous.mode !== "generations" || !previous.generationBands?.length || !previous.occurrences ||
      !previous.branches || previous.positions.length > 6000 || input.people.length > MAX_LOCAL_LAYOUT_PEOPLE ||
      previous.nodeSize?.width !== size.width || previous.nodeSize?.height !== size.height ||
      JSON.stringify(input.links) !== JSON.stringify(previousInput.links)) return;
  const old = new Map(previousInput.people.map(p => [p.id, p]));
  const current = new Map(input.people.map(p => [p.id, p]));
  if (old.size !== previousInput.people.length || current.size !== input.people.length) return;
  const added = input.people.filter(p => !old.has(p.id));
  const removed = previousInput.people.filter(p => !current.has(p.id));
  const changed = input.people.some(p => old.has(p.id) && relations(p) !== relations(old.get(p.id)!));
  const positions = new Map(previous.positions);
  const occurrences = new Map(previous.occurrences.map(o => [o.id, o]));
  if (positions.size !== previous.positions.length || occurrences.size !== positions.size ||
      [...positions].some(([id, p]) => !occurrences.has(id) || !Number.isFinite(p.x) || !Number.isFinite(p.y)) ||
      previous.occurrences.some(o => !old.has(o.personId)) ||
      previousInput.people.some(p => !occurrences.has(p.id) || occurrences.get(p.id)!.personId !== p.id)) return;
  if (added.some(p => positions.has(p.id)) || input.links.some(link =>
    [...added, ...removed].some(p => p.id === link.from || p.id === link.to))) return;
  if (added.length && !removed.length && added.length <= MAX_LOCAL_FAMILY_ADDITIONS &&
      (changed || added.length > 1 || added.some(p => p.spouses.length))) {
    const append = (people: LayoutPerson[], geometry: TreeGeometry, additions: LayoutPerson[]) => {
      let history = { people, links: input.links };
      for (const person of additions) {
        const next = { people: [...history.people, person], links: input.links };
        const result = localTreeLayout(next, history, geometry, size);
        if (!result) return;
        geometry = result.geometry;
        history = next;
      }
      return { geometry, kind: "local" as const };
    };
    if (!changed && added.every(p => !p.spouses.length))
      return append(previousInput.people, previous, added);
    for (const plan of localFamilyGrowth(input.people, previousInput.people, previous, size)) {
      const result = append(plan.people, plan.geometry, plan.children);
      if (result) return result;
    }
    return;
  }
  if (changed) return;
  if (!added.length && !removed.length) {
    // Generation geometry does not depend on a changed date; animation still reads fresh person data.
    if (input.people.some((p, i) => p.id !== previousInput.people[i]?.id)) return;
    return { geometry: previous, kind: "retained" };
  }
  if (added.length + removed.length !== 1) return;
  const leaf = added[0] || removed[0];
  if (leaf.spouses.length || !leaf.parents.length ||
      previousInput.people.some(p => p.parents.includes(leaf.id)) || input.people.some(p => p.parents.includes(leaf.id))) return;
  const known = new Set(input.people.map(p => p.id));
  const families = familyUnions(input.people);
  const family = families.find(f => JSON.stringify(f.members) === JSON.stringify([...leaf.parents].sort()));
  // Removing the last child of unmarried co-parents changes their household projection.
  if (!family) return;
  const beforeFamily = familyUnions(previousInput.people).find(f => f.id === family.id);
  if (!beforeFamily) return;
  const levels = householdLevels(input.people);
  const bandOf = new Map(previous.generationBands.flatMap(b => b.members.map(id => [id, b.level] as const)));
  if (input.people.some(p => old.has(p.id) && bandOf.get(p.id) !== levels.get(p.id))) return;
  if (removed.length) {
    if (previous.occurrences.filter(o => o.personId === leaf.id).length !== 1 ||
        previous.branches.some(b => b.source === leaf.id)) return;
    const geometry: TreeGeometry = { ...previous,
      positions: previous.positions.filter(([id]) => id !== leaf.id),
      occurrences: previous.occurrences.filter(o => o.id !== leaf.id),
      generationBands: previous.generationBands.map(b => ({ ...b, members: b.members.filter(id => id !== leaf.id) })).filter(b => b.members.length),
      branches: previous.branches.filter(b => b.target !== leaf.id).map(b => ({ ...b, relations: b.relations.filter(r => r.to !== leaf.id) })),
    };
    return { geometry: { ...geometry, coveredRelations: undefined }, kind: "local" };
  }
  if (positions.has(leaf.id) || leaf.parents.some(id => !known.has(id))) return;
  const group = groupFamilyUnions(families, levels).find(u => u.families.some(f => f.id === family.id));
  if (!group) return;
  const owner = occurrences.get(leaf.parents[0])?.block;
  const members = previous.occurrences.filter(o => o.block === owner).sort((a, b) => positions.get(a.id)!.x - positions.get(b.id)!.x);
  if (group.id !== owner || members.length !== group.members.length ||
      members.some(o => !group.members.includes(o.personId))) return;
  const origin = positions.get(members[0].id)!;
  if (members.some((o, i) => positions.get(o.id)!.x !== origin.x + i * (size.width + 32) || positions.get(o.id)!.y !== origin.y)) return;
  const groupRoutes = localUnionRoutes({ ...group, members: members.map(o => o.personId) }, size);
  const local = groupRoutes.families.find(f => f.family.id === family.id)!;
  const source = members.find(o => o.personId === family.members[0])!.id;
  const priorBranch = previous.branches.find(b => b.union === family.id && b.id.startsWith("child:"));
  const start = priorBranch?.route.points[0] || { x: origin.x + local.joint.x,
    y: origin.y + (previous.reverse ? size.height - local.joint.y : local.joint.y) };
  const rank = levels.get(leaf.id)!;
  const bands = previous.generationBands.map(b => ({ ...b, members: [...b.members] }));
  let band = bands.find(b => b.level === rank);
  if (!band) {
    const last = bands.at(-1)!;
    if (rank !== last.level + 1) return;
    const targetY = last.targetY + (previous.reverse ? -1 : 1) * Math.max(size.height + 96, 360);
    band = { level: rank, targetY, minY: targetY - GENERATION_DEVIATION, maxY: targetY + GENERATION_DEVIATION, members: [] };
    bands.push(band);
  }
  const y = band.targetY - (previous.reverse ? -10 : 10);
  const direction = previous.reverse ? -1 : 1;
  const endY = y + (previous.reverse ? size.height : 0);
  const sourceOuter = origin.y + (previous.reverse ? -groupRoutes.bottom : size.height + groupRoutes.bottom);
  if (direction * (endY - sourceOuter) < 32) return;
  const preferred = start.x - size.width / 2;
  const obstacles = previous.positions.filter(([, p]) => Math.abs(p.y - y) < size.height + FAMILY_DISPLAY_GAP / 2);
  const candidates = [...new Set([preferred, ...obstacles.flatMap(([, p]) =>
    [p.x - FAMILY_DISPLAY_GAP - size.width, p.x + size.width + FAMILY_DISPLAY_GAP])])]
    .filter(x => Math.abs(x - preferred) <= size.width * 8 && obstacles.every(([, p]) =>
      x + size.width + FAMILY_DISPLAY_GAP <= p.x || x >= p.x + size.width + FAMILY_DISPLAY_GAP))
    .sort((a, b) => Math.abs(a - preferred) - Math.abs(b - preferred) || a - b).slice(0, 6);
  const horizontal = priorBranch?.route.points.slice(1).find((p, i) => p.y === priorBranch.route.points[i].y && p.x !== priorBranch.route.points[i].x);
  const channels = [...new Set([horizontal?.y, (sourceOuter + endY) / 2].filter((v): v is number => v !== undefined))];
  // Only one card and one branch are new. Check their interactions with the
  // fixed scene, rather than recounting all old intersections or indexing very long lines.
  const segments = [...previous.branches.map(b => ({ route: b.route, union: b.union })),
    ...(previous.routes || []).map(([, route]) => ({ route, union: undefined }))]
    .flatMap(({ route, union }) => route.points.slice(1).map((b, i) => ({ a: route.points[i], b, union, box: bounds(route.points[i], b) })));
  if (segments.length > 64000) return;
  const own = segments.filter(s => s.union === family.id);
  const cards = previous.positions.map(([, p]) => ({ left: p.x, right: p.x + size.width, top: p.y, bottom: p.y + size.height }));
  band.members.push(leaf.id);
  for (const x of candidates) for (const channel of channels) {
    if (direction * (channel - sourceOuter) < 16 || direction * (endY - channel) < 16) continue;
    const end = { x: x + size.width / 2, y: endY };
    const branch: UnionBranch = { id: `child:${JSON.stringify(leaf.id)}`, source, target: leaf.id, union: family.id,
      relations: family.members.map(from => ({ from, to: leaf.id, type: "parent" })),
      route: { sourceHandle: previous.reverse ? "top" : "bottom", targetHandle: previous.reverse ? "bottom" : "top",
        points: simplifyRoute([start, { x: start.x, y: channel }, { x: end.x, y: channel }, end]) } };
    const box = { left: x, right: x + size.width, top: y, bottom: y + size.height };
    if (segments.some(s => segmentHitsBox(s.a, s.b, box))) continue;
    if (branch.route.points.slice(1).some((b, i) => {
      const a = branch.route.points[i], rect = bounds(a, b);
      return cards.some(card => segmentHitsBox(a, b, card)) || segments.some(s => {
        if (!s.union || s.union === family.id) return false;
        const other = s.box;
        if (!(rect.left <= other.right && rect.right >= other.left && rect.top <= other.bottom && rect.bottom >= other.top) ||
            !segmentContact(a, b, s.a, s.b)) return false;
        const left = Math.max(rect.left, other.left), right = Math.min(rect.right, other.right),
          top = Math.max(rect.top, other.top), bottom = Math.min(rect.bottom, other.bottom);
        // Reusing an existing sibling trunk does not create another crossing
        // where that exact trunk already meets the same foreign route.
        return !own.some(old => (a.x === b.x ? old.a.x === old.b.x && old.a.x === a.x : old.a.y === old.b.y && old.a.y === a.y) &&
          old.box.left <= left && old.box.right >= right && old.box.top <= top && old.box.bottom >= bottom);
      });
    })) continue;
    const geometry: TreeGeometry = { ...previous, positions: [...previous.positions, [leaf.id, { x, y }]],
      occurrences: [...previous.occurrences, { id: leaf.id, personId: leaf.id, block: `person:${JSON.stringify(leaf.id)}` }],
      generationBands: bands, branches: [...previous.branches.map(b => b.id === `pair:${family.id}` && !family.married
        ? { ...b, relations: family.children.flatMap(to => family.members.map(from => ({ from, to, type: "parent" as const }))) } : b), branch] };
    return { geometry: { ...geometry, coveredRelations: undefined }, kind: "local" };
  }
}
