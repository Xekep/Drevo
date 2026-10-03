import test from "node:test";
import assert from "node:assert/strict";
import { applyPersonDraft, rebasePersonDraft } from "../src/domain/person-draft.ts";
import { openArchive } from "../src/server/database.ts";
import { authorizeArchive } from "../src/server/permissions.ts";
import type { ArchiveUser } from "../src/domain/access.ts";
import type { Family } from "../src/domain/types.ts";

const actor: ArchiveUser = {
  id: "researcher", name: "Researcher", role: "researcher", createdAt: "2026-01-01",
};
const family: Family = {
  title: "Research", description: "", demo: false,
  people: [{
    id: "person", name: "Ada", surname: "Example", patronymic: "", sex: "u",
    birth: "1900", birthPlace: "", parents: [], spouses: [], sources: [],
    generation: 1, column: 0, createdBy: actor.id,
    birthDateClaim: {
      value: "1900", confidence: "probable",
      sources: [{ title: "Register", type: "", reference: "A" }],
    },
  }],
};

test("an open citation draft preserves a newer assessment when saved", async () => {
  const archive = await openArchive(":memory:", family);
  try {
    const opened = await archive.read();
    const draft = structuredClone(opened.family.people[0]);
    draft.birthDateClaim!.sources.push({ title: "Register", type: "", reference: "B" });

    const reassessed = structuredClone(opened.family);
    reassessed.people[0].birthDateClaim!.confidence = "confirmed";
    await archive.write(authorizeArchive(reassessed, opened.family, actor), opened.revision);

    const fresh = await archive.read();
    const merged = rebasePersonDraft(opened.family.people[0], fresh.family.people[0], draft);
    const candidate = applyPersonDraft(fresh.family, merged, []);
    await archive.write(authorizeArchive(candidate, fresh.family, actor), fresh.revision);

    const saved = (await archive.read()).family.people[0].birthDateClaim;
    assert.equal(saved?.confidence, "confirmed", "a citation edit cannot revert a newer assessment");
    assert.deepEqual(saved?.sources.map((source) => source.reference), ["A", "B"]);
  } finally {
    await archive.close();
  }
});

test("competing claim edits require a refresh instead of moving an assessment", () => {
  const base = structuredClone(family.people[0]);
  const fresh = structuredClone(base);
  fresh.birthDateClaim!.confidence = "confirmed";

  const competingAssessment = structuredClone(base);
  competingAssessment.birthDateClaim!.confidence = "tentative";
  assert.throws(() => rebasePersonDraft(base, fresh, competingAssessment),
    /Утверждение изменилось в архиве/);

  const changedValue = structuredClone(base);
  changedValue.birth = "1901";
  changedValue.birthDateClaim!.value = "1901";
  assert.throws(() => rebasePersonDraft(base, fresh, changedValue),
    /Утверждение изменилось в архиве/,
  "a newer assessment of 1900 cannot attach to a draft value of 1901");
});

test("an open event or alternative draft cannot overwrite a newer nested assessment", () => {
  const base = structuredClone(family.people[0]);
  base.events = [{
    id: "residence", type: "residence", date: "1920",
    dateClaim: { value: "1920", sources: [{ title: "Register", type: "", reference: "A" }],
      confidence: "probable" },
  }];
  base.factAlternatives = [{
    id: "earlier-birth", field: "birth", value: "1899",
    sources: [{ title: "Register", type: "", reference: "A" }],
    confidence: "probable",
  }];

  const freshEvent = structuredClone(base);
  freshEvent.events![0].dateClaim!.confidence = "confirmed";
  const draftEvent = structuredClone(base);
  draftEvent.events![0].dateClaim!.sources.push({ title: "Register", type: "", reference: "B" });
  assert.throws(() => rebasePersonDraft(base, freshEvent, draftEvent),
    /Утверждение изменилось в архиве/);

  const freshAlternative = structuredClone(base);
  freshAlternative.factAlternatives![0].confidence = "confirmed";
  const draftAlternative = structuredClone(base);
  draftAlternative.factAlternatives![0].sources.push({ title: "Register", type: "", reference: "B" });
  assert.throws(() => rebasePersonDraft(base, freshAlternative, draftAlternative),
    /Утверждение изменилось в архиве/);
});

for (const kind of ["event", "alternative"] as const) {
  test(`stale unassessed ${kind} citation cannot erase another editor's source`, async () => {
    const initial = structuredClone(family);
    const cited = [{ title: "Register", type: "", reference: "base" }];
    initial.people[0].events = [{ id: "residence", type: "residence", date: "1920",
      dateClaim: { value: "1920", sources: structuredClone(cited) } }];
    initial.people[0].factAlternatives = [{ id: "earlier-birth", field: "birth",
      value: "1899", sources: structuredClone(cited) }];
    const archive = await openArchive(":memory:", initial);
    try {
      const opened = await archive.read();
      const draft = structuredClone(opened.family.people[0]);
      draft.name = "Ada edited";
      const server = structuredClone(opened.family);
      server.people[0].surname = "Updated";
      const sources = (person: typeof draft) => kind === "event"
        ? person.events![0].dateClaim!.sources
        : person.factAlternatives![0].sources;
      sources(draft).push({ title: "Register", type: "", reference: "draft" });
      sources(server.people[0]).push({ title: "Register", type: "", reference: "server" });
      await archive.write(authorizeArchive(server, opened.family, actor), opened.revision);

      const fresh = await archive.read();
      await assert.rejects(async () => {
        const merged = rebasePersonDraft(opened.family.people[0], fresh.family.people[0], draft);
        const candidate = applyPersonDraft(fresh.family, merged, []);
        await archive.write(authorizeArchive(candidate, fresh.family, actor), fresh.revision);
      }, /Утверждение изменилось в архиве/,
      `${kind}: a stale save must leave both the user's draft and the newer source intact`);
      assert.deepEqual(sources((await archive.read()).family.people[0]).map((source) => source.reference),
        ["base", "server"]);
      assert.deepEqual(sources(draft).map((source) => source.reference), ["base", "draft"]);
      assert.equal((await archive.read()).family.people[0].surname, "Updated");
    } finally {
      await archive.close();
    }
  });
}

test("an event citation edit still merges with an independent person field", async () => {
  const initial = structuredClone(family);
  initial.people[0].events = [{ id: "residence", type: "residence", date: "1920",
    dateClaim: { value: "1920", sources: [{ title: "Register", type: "", reference: "base" }] } }];
  const archive = await openArchive(":memory:", initial);
  try {
    const opened = await archive.read();
    const draft = structuredClone(opened.family.people[0]);
    draft.events![0].dateClaim!.sources.push({ title: "Register", type: "", reference: "draft" });
    const server = structuredClone(opened.family);
    server.people[0].surname = "Updated";
    await archive.write(authorizeArchive(server, opened.family, actor), opened.revision);

    const fresh = await archive.read();
    const merged = rebasePersonDraft(opened.family.people[0], fresh.family.people[0], draft);
    await archive.write(authorizeArchive(applyPersonDraft(fresh.family, merged, []),
      fresh.family, actor), fresh.revision);
    const saved = (await archive.read()).family.people[0];
    assert.equal(saved.surname, "Updated");
    assert.deepEqual(saved.events![0].dateClaim!.sources.map((source) => source.reference),
      ["base", "draft"]);
  } finally {
    await archive.close();
  }
});
