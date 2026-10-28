import test from "node:test";
import assert from "node:assert/strict";
import { archiveDetails, ArchiveDetailsAccessError } from "../src/data/archive-details.ts";
import type { ArchivePageHeader } from "../src/data/archive-pages.ts";
import { archiveOverview, personDetails } from "../src/domain/archive-projection.ts";
import { projectFamilyToVisibleIds } from "../src/domain/tree-access.ts";
import type { Family } from "../src/domain/types.ts";
import type { ArchiveTreeFragment, TreeFragmentRequest } from "../src/shared/tree-fragment.ts";
import { familyNeighbors } from "../src/domain/family-neighborhood.ts";
import { fragmentHiddenCounts } from "../src/domain/tree-fragment.ts";
import { assistantVisiblePeople, excludeAssistantPeople } from "../src/domain/research-tree-view.ts";

function setup() {
  const family: Family = { title: "Test", description: "", demo: false,
    people: Array.from({ length: 120 }, (_, i) => ({ id: `p${i}`, name: `Name${i}`, surname: "Test", patronymic: "", sex: "m" as const,
      birth: "", birthPlace: "", parents: i ? [`p${i - 1}`] : [], spouses: [], generation: 1, column: i,
      sources: [], biography: `Biography${i}` })), photos: [] };
  const overview = archiveOverview(family);
  const window = (anchorId: string, start: number, revision = 1) => {
    const peopleIds = family.people.slice(start, start + 10).map(person => person.id);
    const fragment: ArchiveTreeFragment = { anchorId, ancestors: 3, descendants: 3, collateral: 1, expanded: [],
      hidden: [[peopleIds.at(-1)!, 1]], atLimit: false, nextOffset: 0, peopleIds, total: family.people.length, threshold: 100 };
    return { family: projectFamilyToVisibleIds(overview, new Set(peopleIds), ""), fragment, revision,
      pageToken: `${revision}:scope`, partial: true, totals: { people: family.people.length, photos: 0 } };
  };
  return { family, overview, window, initial: window("p0", 0) };
}

test("fragment navigation loads bounded windows; profile/full-view demand retains the active fragment", async () => {
  const { family, overview, initial, window } = setup();
  let latest: ArchivePageHeader = initial;
  const calls: string[] = [];
  const reader = archiveDetails(initial, async (url, init) => {
    calls.push(url);
    const projection = new URL(url, "http://test.local").searchParams.get("projection");
    if (projection === "fragment") {
      assert.equal(init?.method, "POST");
      const demand = JSON.parse(String(init?.body)) as TreeFragmentRequest;
      return Response.json(window(demand.anchorId, demand.anchorId === "p95" ? 90 : 0));
    }
    if (projection === "overview") return Response.json({ ...initial, fragment: undefined, family: overview });
    if (projection === "timeline") return Response.json({ pageToken: initial.pageToken,
      people: family.people.map(person => ({ id: person.id, events: [] })) });
    assert.equal(projection, "details");
    const ids = JSON.parse(new URL(url, "http://test.local").searchParams.get("ids")!);
    return Response.json({ pageToken: initial.pageToken, people: family.people.filter(person => ids.includes(person.id)).map(personDetails),
      photos: [], photoTotal: 0, personPhotoTotals: Object.fromEntries(ids.map((id: string) => [id, 0])) });
  }, header => { latest = header; });
  assert.equal(reader.hasOverview(), false);
  assert.equal(calls.length, 0, "initial fragments never start an archive-wide background read");
  await reader.loadFragment({ anchorId: "p95", ancestors: 3, descendants: 3, collateral: 1 });
  assert.equal(calls.length, 1);
  assert.equal(latest.family.people.length, 10);
  assert.equal(reader.fragment()!.anchorId, "p95");
  await reader.loadPeople(["p95"]);
  assert.equal(calls.filter(url => url.includes("projection=overview")).length, 1);
  assert.equal(latest.family.people.length, family.people.length);
  assert.equal(reader.hasOverview(), true);
  assert.equal(reader.fragment()!.anchorId, "p95", "opening a profile must not reset or reanchor the tree window");
  assert.equal(latest.family.people.find(person => person.id === "p95")!.biography, "Biography95");
  assert.deepEqual(latest.family.people.find(person => person.id === "p95")!.parents, ["p94"]);
  await reader.loadPeople(["p50"]);
  assert.equal(reader.hasPerson("p50"), true, "profiles omitted from the window remain demand-addressable");
  await reader.loadView("timeline");
  assert.equal(reader.hasView("timeline"), true);
  await reader.loadFragment({ anchorId: "p0", ancestors: 3, descendants: 3, collateral: 1 });
  assert.equal(latest.family.people.length, family.people.length, "later fragment navigation preserves already demanded overview data");
  assert.equal(reader.fragment()!.peopleIds.length, 10);
  assert.equal(calls.filter(url => url.includes("projection=overview")).length, 1);
});

test("fragment conflicts refresh their bounded view once, without mixing revisions or hydrating the archive", async () => {
  const { initial, window } = setup();
  let latest: ArchivePageHeader = initial, fragmentCalls = 0;
  const calls: string[] = [];
  const reader = archiveDetails(initial, async url => {
    calls.push(url);
    if (url.includes("projection=overview")) {
      assert.ok(url.includes("fragment=auto"));
      return Response.json(window("p0", 0, 2));
    }
    if (!fragmentCalls++) return Response.json({ error: "Changed" }, { status: 409 });
    assert.equal(new URL(url, "http://test.local").searchParams.get("token"), "2:scope");
    return Response.json(window("p95", 90, 2));
  }, header => { latest = header; });
  await reader.loadFragment({ anchorId: "p95", ancestors: 3, descendants: 3, collateral: 1 });
  assert.equal(calls.length, 3);
  assert.equal(latest.revision, 2);
  assert.equal(latest.family.people.length, 10);
  assert.equal(reader.hasOverview(), false);
  assert.equal(latest.fragment!.anchorId, "p95");
});

test("revoked or malformed fragments never publish an incomplete or unauthorized family", async () => {
  const { initial, window } = setup();
  let publications = 0, denied = true;
  const reader = archiveDetails(initial, async () => denied
    ? Response.json({ error: "Access changed" }, { status: 403 })
    : Response.json({ ...window("p95", 90), fragment: { ...window("p95", 90).fragment, peopleIds: ["hidden"] } }),
  () => { publications++; });
  const demand: TreeFragmentRequest = { anchorId: "p95", ancestors: 3, descendants: 3, collateral: 1 };
  await assert.rejects(reader.loadFragment(demand), ArchiveDetailsAccessError);
  denied = false;
  await assert.rejects(reader.loadFragment(demand), /Некорректный фрагмент/);
  assert.equal(publications, 0);
  assert.equal(reader.fragment()!.anchorId, "p0");
});

test("demanding full topology and navigating another window preserve AI exclusions and the anchor", () => {
  const { family, window } = setup();
  const index = familyNeighbors(family), allowed = new Set(family.people.map(person => person.id));
  const original = window("p5", 0).fragment;
  const filter = excludeAssistantPeople(null, ["p5", "p10", "p20"], "Скрыть", 1);
  const displayAllowed = assistantVisiblePeople(family.people, allowed, filter);
  const current = new Set(original.peopleIds);
  const before = [...current];
  assert.equal(fragmentHiddenCounts(index, current, displayAllowed).has("p9"), false,
    "an excluded boundary neighbor is not offered by a misleading continuation count");
  assert.deepEqual([...current], before, "recounting is not a new tree projection");
  assert.equal(original.anchorId, "p5", "excluding the anchor must not choose a replacement anchor");
  for (const fragment of [original, window("p15", 10).fragment]) {
    const displayed = assistantVisiblePeople(family.people, new Set(fragment.peopleIds), filter);
    for (const id of filter.excludeIds!) assert.equal(displayed.has(id), false,
      "a server continuation never overrides the user's existing exclusion");
  }
});
