import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { openArchive } from "../src/server/database.ts";
import { archiveQueryHttp } from "../src/server/archive-query-http.ts";
import { validateFamily } from "../src/domain/validation.ts";
import { analyzeKinship } from "../src/domain/kinship-analysis.ts";
import { kinshipRelationLabel } from "../src/domain/kinship-label.ts";
import { DEFAULT_TREE_PREFERENCES } from "../src/domain/tree-preferences.ts";
import type { createAuth } from "../src/server/auth.ts";
import type { settingsStore } from "../src/server/settings.ts";
import type { treePreferencesStore } from "../src/server/tree-preferences.ts";
import type { researchCatalogStore } from "../src/server/research-catalog.ts";
import type { ArchiveUser } from "../src/domain/access.ts";
import type { Family, Person } from "../src/domain/types.ts";

const person = (id: string, parents: string[] = []): Person => ({ id, parents,
  name: id, surname: "Тест", patronymic: "", sex: "m", birth: "", birthPlace: "",
  spouses: [], generation: 1, column: 0, sources: [], biography: `Private biography ${id}` });

test("large-tree initial HTTP payload and continuation windows are bounded, closed and scoped", async t => {
  const seed: Family = { title: "Фрагменты", description: "", demo: false,
    people: [person("root"), ...Array.from({ length: 800 }, (_, i) => person(`p${i}`, ["root"])), person("hidden")], photos: [] };
  seed.people[0] = { ...seed.people[0], sex: "u", patronymic: "Иванович" };
  const reference = seed.people.find(person => person.id === "p600")!;
  Object.assign(reference, { sex: "u", name: "НепубличноеИмяРеференса", patronymic: "Васильевич" });
  const store = await openArchive(":memory:", seed);
  let actor: ArchiveUser | null = { id: "reader", name: "Читатель", role: "reader", approved: true,
    personId: "p600", treeAccess: "common_ancestors", createdAt: "2026-01-01" };
  let access = { publicTree: false, publicAlbums: false };
  let preferredThreshold: number | null = null;
  let onDelivery: (() => void) | undefined;
  // Automatic fragments must not obtain archive-wide personal fields/details.
  const overview = store.overview, scopedOverview = store.scopedOverview;
  store.read = async () => { throw new Error("Full snapshot forbidden"); };
  store.overview = async () => { throw new Error("Full overview forbidden during fragments"); };
  store.scopedOverview = async () => { throw new Error("Full scoped overview forbidden during fragments"); };
  const handler = archiveQueryHttp({ archive: store,
    auth: { local: true, currentUser: async () => actor, canEdit: async () => false, isPlatformAdmin: async () => false } as unknown as Awaited<ReturnType<typeof createAuth>>,
    visibility: { read: async () => access } as Awaited<ReturnType<typeof settingsStore>>,
    treePreferences: { read: async () => preferredThreshold === null ? null : { ...DEFAULT_TREE_PREFERENCES, fragmentThreshold: preferredThreshold } } as unknown as ReturnType<typeof treePreferencesStore>,
    researchCatalog: {} as ReturnType<typeof researchCatalogStore>,
    beforeDelivery: async () => { const run = onDelivery; onDelivery = undefined; run?.(); },
  });
  const server = createServer((req, res) => void handler(req, res, new URL(req.url || "/", "http://test.local")).catch(error => {
    res.writeHead(500); res.end(String(error));
  }));
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); handler.close(); await store.close(); });
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}/api/family`;
  const initialResponse = await fetch(`${base}?projection=overview&fragment=auto&anchor=root`);
  assert.equal(initialResponse.status, 200);
  const initial = await initialResponse.json();
  validateFamily(initial.family);
  assert.equal(initial.family.people.length, 500);
  assert.equal(initial.totals.people, 801);
  assert.equal(initial.fragment.atLimit, true);
  assert.equal(initial.fragment.hidden.find(([id]: [string]) => id === "root")[1], 301);
  assert.equal(initial.fragment.referenceId, actor.personId);
  assert.equal(Object.keys(initial.fragment.relationLabels).length, 500);
  assert.equal(initial.fragment.relationLabels.root, kinshipRelationLabel(analyzeKinship(seed.people[0], reference, seed.people)),
    "legacy unknown-sex records retain client name-hint relationship terms");
  assert.doesNotMatch(JSON.stringify(initial), /Private biography|"id":"hidden"|НепубличноеИмяРеференса/);
  const command = { anchorId: "root", ancestors: 3, descendants: 3, collateral: 1,
    previous: initial.fragment.peopleIds, offset: initial.fragment.nextOffset };
  const fragment = (body: unknown, token = initial.pageToken) => fetch(`${base}?projection=fragment&token=${encodeURIComponent(token)}`,
    { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  const nextResponse = await fragment(command);
  assert.equal(nextResponse.status, 200);
  const next = await nextResponse.json();
  validateFamily(next.family);
  assert.equal(next.family.people.length, 500);
  assert.equal(new Set([...initial.fragment.peopleIds, ...next.fragment.peopleIds]).size, 801,
    "a wide parent continuation visits omitted children rather than replaying the first 500");
  assert.equal(next.fragment.relationLabels.root, "Отец", "the reference need not occur in the emitted window");
  for (const anchorId of ["hidden", "missing"]) {
    const response = await fragment({ ...command, anchorId });
    assert.equal(response.status, 404);
    assert.equal((await response.json()).error, "Человек не найден или недоступен");
  }
  for (const body of [{ ...command, ancestors: 100 }, { ...command, limit: 10000 },
    { ...command, expanded: Array.from({ length: 501 }, (_, i) => `p${i}`) }, { ...command, previous: ["hidden"] }])
    assert.ok([400, 404].includes((await fragment(body)).status));
  assert.equal((await fragment(command, "old")).status, 409);
  await store.db.prepare("UPDATE archive SET revision=revision+1 WHERE id=1").run();
  assert.equal((await fragment(command)).status, 409);
  store.overview = overview; store.scopedOverview = scopedOverview;
  const latestResponse = await fetch(`${base}?projection=overview&fragment=auto&anchor=root`);
  assert.equal(latestResponse.status, 200);
  const latest = await latestResponse.json();
  assert.equal(latest.revision, initial.revision + 1);
  const member = actor;
  onDelivery = () => { actor = { ...member!, approved: false }; };
  const denied = await fragment(command, latest.pageToken);
  assert.equal(denied.status, 409);
  assert.doesNotMatch(await denied.text(), /"p\d+"|"people"/);
  actor = null; access = { publicTree: true, publicAlbums: false };
  const guestResponse = await fetch(`${base}?projection=overview&fragment=auto&anchor=root`);
  assert.equal(guestResponse.status, 200);
  const guest = await guestResponse.json();
  assert.equal(guest.totals.photos, 0);
  const guestNext = await fragment(command, guest.pageToken);
  assert.equal(guestNext.status, 200);
  assert.equal((await guestNext.json()).totals.photos, 0);
  const guestManualResponse = await fetch(`${base}?projection=overview`, { headers: {
    "X-Drevo-Fragment": "auto", "X-Drevo-Fragment-Threshold": "0",
  } });
  assert.equal(guestManualResponse.status, 200);
  const guestManual = await guestManualResponse.json();
  assert.equal(guestManual.fragment, undefined, "guest browser preferences can disable automatic startup windows");
  assert.equal(guestManual.family.people.length, seed.people.length);
  actor = { ...member!, personId: "hidden" }; access = { publicTree: false, publicAlbums: false };
  for (const threshold of [100, 500, 10000]) {
    const response = await fetch(`${base}?projection=overview&fragment=auto&threshold=${threshold}`);
    assert.equal(response.status, 200);
    const small = await response.json();
    assert.equal(small.totals.people, 1);
    assert.equal(small.family.people.length, 1);
    assert.equal(small.fragment, undefined, "private archive size must not activate a participant's fragment");
  }
  const headerResponse = await fetch(`${base}?projection=overview`, { headers: { "X-Drevo-Fragment": "auto" } });
  assert.equal(headerResponse.status, 200);
  assert.equal((await headerResponse.json()).fragment, undefined);
  for (const invalid of ["5e2", "-1", "100.0", "", "abc", "10001"])
    assert.equal((await fetch(`${base}?projection=overview&fragment=auto&threshold=${invalid}`)).status, 400);
  assert.equal((await fetch(`${base}?projection=overview`, { headers: { "X-Drevo-Fragment": "all" } })).status, 400);
  assert.equal((await fetch(`${base}?projection=overview&fragment=all`)).status, 400);
  assert.equal((await fetch(`${base}?projection=overview&fragment=auto&anchor=root`,
    { headers: { "X-Drevo-Fragment-Anchor": "hidden" } })).status, 400);
  actor = member; preferredThreshold = 0;
  const disabled = await fetch(`${base}?projection=overview&fragment=auto&threshold=500`);
  assert.equal(disabled.status, 200);
  assert.equal((await disabled.json()).fragment, undefined, "a stale client threshold must not override the saved participant preference");
});
