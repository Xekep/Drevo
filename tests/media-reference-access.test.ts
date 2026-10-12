import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:http";
import type {
  ArchiveUser,
  Family,
  Person,
  Source,
} from "../src/domain/index.ts";
import { projectFamilyForUser } from "../src/domain/tree-access.ts";
import { openArchive } from "../src/server/database.ts";
import { archiveRows } from "../src/server/archive-rows.ts";
import {
  allCitations,
  hydrateCatalogCitations,
  sourceCatalogStore,
} from "../src/server/source-catalog-store.ts";
import { mediaReferenceAccess } from "../src/server/media-reference-access.ts";
import { mediaHttp } from "../src/server/media-http.ts";
import { mediaStore } from "../src/server/media.ts";
import type { createAuth } from "../src/server/auth.ts";
import type { settingsStore } from "../src/server/settings.ts";
import type { CatalogSource } from "../src/shared/source-catalog.ts";

const citation = (name: string): Source => ({
  title: name,
  type: "archive",
  reference: "",
  url: `/media/${name}.png#page=2?variant=thumb`,
});
const person = (id: string, createdBy = "other"): Person => ({
  id,
  name: id,
  surname: "Test",
  patronymic: "",
  sex: "u",
  birth: "",
  birthPlace: "",
  sources: [],
  parents: [],
  spouses: [],
  generation: 1,
  column: 0,
  createdBy,
});
const member: ArchiveUser = {
  id: "member",
  name: "Member",
  role: "relative",
  treeAccess: "common_ancestors",
  personId: "self",
  approved: true,
  createdAt: "",
};
const otherMember: ArchiveUser = {
  ...member,
  id: "other-member",
  personId: "hidden",
};
const family = (): Family => {
  const self = person("self", member.id),
    child = person("child"),
    own = person("own", member.id),
    hidden = person("hidden");
  self.photo = "/media/portrait.png";
  hidden.photo = "/media/hidden-portrait.png";
  self.sources = [citation("person")];
  self.birth = "1950";
  self.death = "2000";
  self.birthPlace = "Birth place";
  self.deathPlace = "Death place";
  self.occupation = "Researcher";
  self.maidenName = "Birth name";
  for (const claim of [
    "birthDateClaim",
    "deathDateClaim",
    "birthPlaceClaim",
    "deathPlaceClaim",
    "occupationClaim",
    "maidenNameClaim",
  ] as const)
    self[claim] = {
      value: {
        birthDateClaim: self.birth,
        deathDateClaim: self.death,
        birthPlaceClaim: self.birthPlace,
        deathPlaceClaim: self.deathPlace,
        occupationClaim: self.occupation,
        maidenNameClaim: self.maidenName,
      }[claim]!,
      sources: [citation(claim)],
    };
  self.factAlternatives = [
    {
      id: "alternative",
      field: "birth",
      value: "1951",
      sources: [citation("alternative")],
    },
  ];
  self.awards = [
    { id: "award", name: "Synthetic", sources: [citation("award")] },
  ];
  self.events = [
    {
      id: "event",
      type: "residence",
      date: "1970",
      place: "Place",
      sources: [citation("event")],
      dateClaim: { value: "1970", sources: [citation("event-date")] },
      placeClaim: { value: "Place", sources: [citation("event-place")] },
      alternatives: [
        {
          id: "alternative",
          field: "place",
          value: "Another place",
          sources: [citation("event-alternative")],
        },
      ],
    },
  ];
  child.parents = [self.id];
  child.parentClaims = [{ parentId: self.id, sources: [citation("parent")] }];
  own.parents = [hidden.id];
  own.parentClaims = [
    { parentId: hidden.id, sources: [citation("hidden-parent")] },
  ];
  return {
    title: "Synthetic",
    description: "",
    demo: false,
    people: [self, child, own, hidden, person("unrelated")],
    photos: [
      {
        id: "tagged",
        title: "Tagged",
        url: "/media/tagged.png",
        tags: [
          { id: "tag", personId: child.id, x: 0, y: 0, width: 1, height: 1 },
        ],
      },
      {
        id: "owned",
        title: "Owned",
        url: "/media/owned.png",
        tags: [],
        createdBy: member.id,
      },
      {
        id: "hidden",
        title: "Hidden",
        url: "/media/hidden.png",
        tags: [
          {
            id: "hidden-tag",
            personId: hidden.id,
            x: 0,
            y: 0,
            width: 1,
            height: 1,
          },
        ],
      },
    ],
    links: [
      {
        id: "visible-link",
        from: self.id,
        to: own.id,
        type: "godparent",
        sources: [citation("link")],
      },
      {
        id: "hidden-link",
        from: self.id,
        to: hidden.id,
        type: "godparent",
        sources: [citation("hidden-link")],
      },
    ],
    unions: [
      {
        id: "visible-union",
        participants: [self.id, own.id],
        type: "partnership",
        sources: [citation("union")],
        formation: { sources: [citation("formation")] },
        ending: { sources: [citation("ending")] },
        divorce: { sources: [citation("divorce")] },
        ongoing: { sources: [citation("ongoing")] },
      },
      {
        id: "hidden-union",
        participants: [own.id, hidden.id],
        type: "partnership",
        sources: [citation("hidden-union")],
      },
    ],
  };
};
const catalog: CatalogSource = {
  id: "catalog",
  title: "Catalog",
  type: "",
  author: "",
  institution: "",
  archive: "",
  fond: "",
  opis: "",
  delo: "",
  sheet: "",
  reference: "",
  url: "",
  accessedAt: "",
  description: "",
  documentIds: [],
};
async function fixtureArchive() {
  const raw = family(),
    seed = structuredClone(raw);
  // Some historical citation slots accept local files on read even though today's
  // event editor permits only HTTP URLs. Exercise that persisted read compatibility.
  for (const source of allCitations(seed)) delete source.url;
  for (const union of seed.unions || []) {
    delete union.formation;
    delete union.ending;
    delete union.divorce;
    delete union.ongoing;
  }
  const archive = await openArchive(":memory:", seed);
  const rows = archiveRows(raw);
  await archive.db.transaction(async () => {
    for (const row of rows.people)
      await archive.db
        .prepare("UPDATE people SET data=? WHERE id=?")
        .run(row.data, row.id);
    for (const row of rows.relations)
      await archive.db
        .prepare("UPDATE relations SET sources=? WHERE id=?")
        .run(row.sources, row.id);
    for (const row of rows.unions)
      await archive.db
        .prepare("UPDATE family_unions SET data=? WHERE id=?")
        .run(row.data, row.id);
    await archive.db
      .prepare("UPDATE archive SET revision=revision+1 WHERE id=1")
      .run();
  });
  return archive;
}
const fullVisibleUrls = (data: Family, user: ArchiveUser) => {
  const visible = projectFamilyForUser(data, user);
  return new Set(
    [
      ...visible.people.map((item) => item.photo),
      ...(visible.photos || []).map((item) => item.url),
      ...allCitations(visible).map((item) => item.url?.split(/[?#]/, 1)[0]),
    ].filter((item): item is string => !!item),
  );
};

test("SQL URL authorization matches complete projected families for every citation slot, albums, portraits and current catalogue overrides", async () => {
  const archive = await fixtureArchive();
  const catalogStore = sourceCatalogStore(archive.db);
  await catalogStore.insert(catalog);
  const raw = family();
  raw.people[0].sources.push({
    ...citation("catalog-clears"),
    catalogId: "catalog",
  });
  await archive.db
    .prepare(
      "UPDATE people SET data=json_set(data,'$.sources',json(?)) WHERE id='self'",
    )
    .run(JSON.stringify(raw.people[0].sources));
  try {
    const snapshot = (await archive.read()).family;
    const urls = new Set([
      ...fullVisibleUrls(snapshot, { ...member, treeAccess: "all" }),
      "/media/catalog-clears.png",
      "/media/missing.png",
    ]);
    const canRead = mediaReferenceAccess(archive);
    for (const user of [
      member,
      otherMember,
      { ...member, treeAccess: "all" as const },
    ]) {
      const expected = fullVisibleUrls(snapshot, user);
      for (const url of urls)
        assert.equal(
          await canRead(url, user),
          expected.has(url),
          `${user.id}/${user.treeAccess}: ${url}`,
        );
    }
    const revision = (await archive.meta()).revision;
    assert.equal(
      await canRead("/media/catalog-clears.png", member),
      false,
      "an empty catalogue URL replaces the stale inline URL",
    );
    await catalogStore.remove(catalog.id, 1);
    assert.equal((await archive.meta()).revision, revision);
    const rehydrated = await hydrateCatalogCitations(
      archive.db,
      structuredClone(raw),
    );
    assert.equal(
      await canRead("/media/catalog-clears.png", member),
      fullVisibleUrls(rehydrated, member).has("/media/catalog-clears.png"),
      "catalogue changes are checked without a revision-based URL grant cache",
    );
    await archive.db
      .prepare(
        "UPDATE people SET data=json_set(data,'$.unknown.sources',json(?)) WHERE id='self'",
      )
      .run(JSON.stringify([citation("missing")]));
    assert.equal(
      await canRead("/media/missing.png", member),
      false,
      "unsupported JSON fields cannot smuggle a citation grant",
    );
  } finally {
    await archive.close();
  }
});

test("alternating scoped HTTP image readers never hydrate the full archive", async () => {
  const directory = await mkdtemp(join(tmpdir(), "drevo-media-sql-access-"));
  const archive = await fixtureArchive();
  await writeFile(join(directory, "portrait.png"), "synthetic-image");
  const originalRead = archive.read;
  archive.read = async () => {
    throw new Error("full archive read forbidden");
  };
  const auth = {
    local: true,
    canRead: async () => true,
    currentUser: async (req: { headers: Record<string, unknown> }) =>
      req.headers["x-test-reader"] === "other"
        ? { ...otherMember, personId: "unrelated" }
        : member,
  } as unknown as Awaited<ReturnType<typeof createAuth>>;
  const handler = mediaHttp({
    archive,
    auth,
    media: mediaStore(directory),
    previewImage: async () => Buffer.from("preview"),
    visibility: {
      read: async () => ({ publicTree: false, publicAlbums: false }),
    } as Awaited<ReturnType<typeof settingsStore>>,
  });
  const server = createServer((req, res) => {
    void handler(req, res, new URL(req.url || "/", "http://localhost")).catch(
      (error) => res.writeHead(500).end(error.message),
    );
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    for (const reader of ["member", "other", "member", "other", "member"]) {
      const response = await fetch(`${origin}/media/portrait.png`, {
        headers: { "x-test-reader": reader },
      });
      assert.equal(response.status, reader === "member" ? 200 : 401);
      await response.text();
    }
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    archive.read = originalRead;
    await archive.close();
    await rm(directory, { recursive: true, force: true });
  }
});
