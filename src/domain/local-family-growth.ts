import type { LayoutPerson, TreeGeometry } from "./tree-layout.ts";
import type { TreeNodeSize } from "./tree-layout-constants.ts";
import { FAMILY_DISPLAY_GAP } from "./tree-layout-constants.ts";
import { familyUnions, type UnionBranch } from "./union-layout.ts";
import { householdLevels } from "./household-levels.ts";
import { localUnionRoutes } from "./union-groups.ts";
import { bounds, segmentContact, segmentHitsBox } from "./edge-routing.ts";

/** A bounded atomic family edit; crowded or ambiguous plans use the full solver. */
export const MAX_LOCAL_FAMILY_ADDITIONS = 16;

/** Place a first partner beside an existing terminal person, keeping old routes.
 * The caller appends the new children with the normal guarded leaf placer and
 * publishes only a complete plan. No partial family is returned to the Worker.
 */
export function* localFamilyGrowth(
  people: LayoutPerson[],
  previousPeople: LayoutPerson[],
  previous: TreeGeometry,
  size: TreeNodeSize,
) {
  const old = new Map(previousPeople.map((p) => [p.id, p]));
  const added = people.filter((p) => !old.has(p.id));
  if (!added.length || added.length > MAX_LOCAL_FAMILY_ADDITIONS) return;
  const families = familyUnions(people);
  const pairs = families.filter(
    (f) =>
      f.married &&
      f.members.length === 2 &&
      f.members.filter((id) => old.has(id)).length === 1,
  );
  if (pairs.length !== 1) return;
  const family = pairs[0];
  const anchorId = family.members.find((id) => old.has(id))!;
  const partnerId = family.members.find((id) => !old.has(id))!;
  const anchor = people.find((p) => p.id === anchorId)!;
  const partner = added.find((p) => p.id === partnerId);
  if (
    !partner ||
    partner.parents.length ||
    old.get(anchorId)!.spouses.length ||
    previousPeople.some(
      (p) => p.parents.includes(anchorId) || p.spouses.includes(anchorId),
    ) ||
    anchor.spouses.some((id) => id !== partnerId) ||
    partner.spouses.some((id) => id !== anchorId) ||
    families.some(
      (f) =>
        f !== family &&
        (f.members.includes(anchorId) || f.members.includes(partnerId)),
    )
  )
    return;
  for (const person of people) {
    const before = old.get(person.id);
    if (!before) continue;
    if (
      JSON.stringify(person.parents) !== JSON.stringify(before.parents) ||
      (person.id !== anchorId &&
        JSON.stringify(person.spouses) !== JSON.stringify(before.spouses))
    )
      return;
  }
  const children = added.filter((p) => p.id !== partnerId);
  if (
    children.some(
      (p) =>
        p.spouses.length ||
        p.parents.length !== 2 ||
        !family.members.every((id) => p.parents.includes(id)),
    ) ||
    family.children.some((id) => old.has(id))
  )
    return;
  const position = new Map(previous.positions);
  const point = position.get(anchorId);
  const occurrence = previous.occurrences?.filter(
    (o) => o.personId === anchorId,
  );
  if (
    !point ||
    occurrence?.length !== 1 ||
    occurrence[0].id !== anchorId ||
    occurrence[0].block !== `person:${JSON.stringify(anchorId)}` ||
    [...(previous.blocks || []), ...(previous.siblingGroups || [])].some((b) =>
      b.members.includes(anchorId),
    )
  )
    return;
  const levels = householdLevels(people);
  const bandOf = new Map(
    previous.generationBands!.flatMap((b) =>
      b.members.map((id) => [id, b.level] as const),
    ),
  );
  if (
    previousPeople.some((p) => bandOf.get(p.id) !== levels.get(p.id)) ||
    levels.get(partnerId) !== bandOf.get(anchorId) ||
    children.some((p) => levels.get(p.id) !== levels.get(anchorId)! + 1)
  )
    return;
  const routes = [
    ...previous.branches!.map((b) => b.route),
    ...(previous.routes || []).map(([, route]) => route),
  ];
  const segments = routes.flatMap((route) =>
    route.points.slice(1).map((b, i) => ({ a: route.points[i], b })),
  );
  if (segments.length > 64000) return;
  const cards = previous.positions.map(([id, p]) => ({
    id,
    p,
    box: {
      left: p.x,
      right: p.x + size.width,
      top: p.y,
      bottom: p.y + size.height,
    },
  }));
  for (const side of [1, -1]) {
    const partnerPoint = { x: point.x + side * (size.width + 32), y: point.y };
    const box = {
      left: partnerPoint.x,
      right: partnerPoint.x + size.width,
      top: partnerPoint.y,
      bottom: partnerPoint.y + size.height,
    };
    if (
      cards.some(
        (card) =>
          card.id !== anchorId &&
          Math.abs(card.p.y - point.y) < size.height + FAMILY_DISPLAY_GAP / 2 &&
          !(
            box.right + FAMILY_DISPLAY_GAP <= card.box.left ||
            box.left >= card.box.right + FAMILY_DISPLAY_GAP
          ),
      ) ||
      segments.some((s) => segmentHitsBox(s.a, s.b, box))
    )
      continue;
    const members = side === 1 ? [anchorId, partnerId] : [partnerId, anchorId];
    const x = Math.min(point.x, partnerPoint.x);
    const pair = localUnionRoutes(
      { id: family.id, members, families: [family] },
      size,
    ).families[0].pair!;
    const branch: UnionBranch = {
      id: `pair:${family.id}`,
      union: family.id,
      source: family.members[0],
      target: family.members[1],
      relations: [
        { from: family.members[0], to: family.members[1], type: "spouse" },
      ],
      route: {
        ...pair,
        points: pair.points.map((p) => ({ x: x + p.x, y: point.y + p.y })),
      },
    };
    const a = branch.route.points[0],
      b = branch.route.points[1],
      rect = bounds(a, b);
    if (
      cards.some((card) => segmentHitsBox(a, b, card.box)) ||
      segments.some((s) => {
        const other = bounds(s.a, s.b);
        return (
          rect.left <= other.right &&
          rect.right >= other.left &&
          rect.top <= other.bottom &&
          rect.bottom >= other.top &&
          !!segmentContact(a, b, s.a, s.b)
        );
      })
    )
      continue;
    const basePeople = people.filter(
      (p) => old.has(p.id) || p.id === partnerId,
    );
    const geometry: TreeGeometry = {
      ...previous,
      positions: [...previous.positions, [partnerId, partnerPoint]],
      occurrences: [
        ...previous.occurrences!.map((o) =>
          o.id === anchorId ? { ...o, block: family.id } : o,
        ),
        { id: partnerId, personId: partnerId, block: family.id },
      ],
      blocks: [
        ...(previous.blocks || []),
        {
          id: family.id,
          members,
          x,
          y: point.y,
          width: 2 * size.width + 32,
          height: size.height,
        },
      ],
      generationBands: previous.generationBands!.map((b) =>
        b.members.includes(anchorId)
          ? { ...b, members: [...b.members, partnerId] }
          : b,
      ),
      branches: [...previous.branches!, branch],
      coveredRelations: undefined,
    };
    yield { people: basePeople, geometry, children };
  }
}
