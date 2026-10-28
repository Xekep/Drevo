import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startServer } from "../src/server/index.ts";
import { openArchive } from "../src/server/database.ts";
import { archiveChanges, inverseChanges } from "../src/domain/changes.ts";
import type { Family, Person } from "../src/domain/types.ts";
import { userStore } from "../src/server/users.ts";
import { readArchiveForChanges } from "../src/server/archive-change-read.ts";
import { ForbiddenError } from "../src/server/users.ts";

const person = (id: string, birth = "1950", createdBy = "local"): Person => ({
  id,
  name: id,
  surname: "Тестов",
  patronymic: "",
  birth,
  birthPlace: "",
  sex: "m",
  generation: 1,
  column: 0,
  parents: [],
  spouses: [],
  sources: [],
  createdBy,
});
const actor = {
  id: "local",
  name: "Локальный",
  role: "admin" as const,
  approved: true,
  createdAt: "2026-01-01",
};
const seed = (): Family => ({
  title: "Дельты",
  description: "",
  demo: false,
  people: [
    person("father"),
    { ...person("child", "1980"), parents: ["father"] },
    ...Array.from({ length: 100 }, (_, index) => ({
      ...person(`unrelated-${index}`),
      biography: `PRIVATE-UNTOUCHED-${index}:` + "История. ".repeat(1500),
      awards: [
        {
          id: "medal",
          name: "Медаль",
          sources: [{ title: "Основание", type: "", reference: "" }],
        },
      ],
      events: [
        {
          id: "residence",
          type: "residence" as const,
          description: "Сведения",
        },
      ],
    })),
  ],
  photos: [
    {
      id: "album",
      url: "/media/album.png",
      title: "Нетронутый альбом",
      tags: [{ id: "tag", personId: "child", x: 0, y: 0, width: 1, height: 1 }],
    },
  ],
});

test("live HTTP structural/evidence deltas avoid archive snapshots and preserve untouched JSON and inverse history", async () => {
  const directory = mkdtempSync(join(tmpdir(), "drevo-bounded-mutation-"));
  const previousOrigin = process.env.PUBLIC_ORIGIN;
  delete process.env.PUBLIC_ORIGIN;
  const app = await startServer(0, join(directory, "archive.sqlite"), true);
  try {
    await app.archive.write(seed(), (await app.archive.meta()).revision);
    const initial = await app.archive.read(),
      next = structuredClone(initial.family);
    next.people[0].parents = ["grandparent"];
    next.people[0].sources = [
      { title: "Метрическая книга", type: "архив", reference: "л. 7" },
    ];
    next.people[0].events = [{ id: "work", type: "work", date: "1980" }];
    next.people.push(person("grandparent", "1920"));
    next.links = [
      { id: "godparent", from: "grandparent", to: "child", type: "godparent" },
    ];
    next.unions = [
      {
        id: "union",
        participants: ["father", "grandparent"],
        type: "partnership",
      },
    ];
    const beforeRaw = await app.archive.db
      .prepare("SELECT data FROM people WHERE id='unrelated-0'")
      .get();
    const read = app.archive.read,
      write = app.archive.write;
    app.archive.read = async () => {
      throw new Error("Unexpected full archive read");
    };
    app.archive.write = async () => {
      throw new Error("Unexpected full archive write");
    };
    const base = `http://127.0.0.1:${(app.server.address() as { port: number }).port}`;
    const send = (
      revision: number,
      changes: ReturnType<typeof archiveChanges>,
    ) =>
      fetch(base + "/api/family/changes", {
        method: "POST",
        headers: {
          Origin: base,
          "Content-Type": "application/json",
          "If-Match": String(revision),
          Prefer: "return=minimal",
        },
        body: JSON.stringify({ changes }),
      });
    let saved: {
      revision: number;
      appliedChanges: ReturnType<typeof archiveChanges>;
      family?: Family;
    };
    try {
      const response = await send(
        initial.revision,
        archiveChanges(initial.family, next),
      );
      assert.equal(response.status, 200, await response.clone().text());
      assert.equal(
        response.headers.get("Preference-Applied"),
        "return=minimal",
      );
      saved = await response.json();
      assert.equal(saved.family, undefined);
      assert.equal(saved.revision, initial.revision + 1);
      assert.ok(
        saved.appliedChanges.every(
          (change) => !change.id?.startsWith("unrelated-"),
        ),
      );
      assert.equal(
        (
          await app.archive.db
            .prepare("SELECT data FROM people WHERE id='unrelated-0'")
            .get()
        )?.data,
        beforeRaw?.data,
        "a projected person is never persisted over the complete record",
      );
      const history = JSON.parse(
        String(
          (await app.archive.db
            .prepare("SELECT data FROM history WHERE revision=?")
            .get(initial.revision))!.data,
        ),
      );
      assert.equal(history.format, "drevo-archive-changes-v1");
      assert.ok(
        JSON.stringify(history).length < 8000,
        "history stores the delta, not all biographies/photos",
      );
      const undone = await send(
        saved.revision,
        inverseChanges(saved.appliedChanges),
      );
      assert.equal(undone.status, 200, await undone.clone().text());
    } finally {
      app.archive.read = read;
      app.archive.write = write;
    }
    assert.deepEqual((await app.archive.read()).family, initial.family);
    assert.deepEqual(
      archiveChanges(
        initial.family,
        await app.archive.readRevision(initial.revision),
      ),
      [],
      "inverse history reconstructs every field and record; absent optional collections equal empty ones",
    );
  } finally {
    await app.close();
    if (previousOrigin === undefined) delete process.env.PUBLIC_ORIGIN;
    else process.env.PUBLIC_ORIGIN = previousOrigin;
    rmSync(directory, { recursive: true, force: true });
  }
});

test("write graph transfers compact unchanged people and only target photos", async () => {
  const archive = await openArchive(":memory:", seed());
  try {
    const value = await archive.db.transaction(() =>
      readArchiveForChanges(archive.db, [
        {
          collection: "people",
          id: "father",
          field: "events",
          before: undefined,
          after: [],
        },
      ]),
    );
    assert.equal(value.family.people.length, 102);
    assert.equal(value.family.photos?.length, 0);
    assert.equal(value.family.people[2].biography, undefined);
    assert.equal(value.family.people[2].awards, undefined);
    assert.equal(value.family.people[2].events, undefined);
    assert.ok(JSON.stringify(value.family).length < 40000);
    const deleted = await archive.db.transaction(() =>
      readArchiveForChanges(archive.db, [
        {
          collection: "people",
          id: "child",
          before: person("child"),
          after: undefined,
        },
      ]),
    );
    assert.equal(
      deleted.family.photos?.[0].id,
      "album",
      "incident tags must be validated on person deletion",
    );
  } finally {
    await archive.close();
  }
});

test("delta writer validates global ancestry, incident dates, catalogs and independent concurrent changes atomically", async () => {
  const archive = await openArchive(":memory:", seed());
  try {
    const initial = await archive.read();
    const invalid = [
      {
        collection: "people" as const,
        id: "father",
        field: "parents",
        before: [],
        after: ["child"],
      },
      {
        collection: "people" as const,
        id: "father",
        field: "birth",
        before: "1950",
        after: "1990",
      },
      {
        collection: "people" as const,
        id: "father",
        field: "sources",
        before: [],
        after: [
          {
            catalogId: "another-tree-source",
            title: "Источник",
            type: "",
            reference: "",
          },
        ],
      },
    ];
    for (const change of invalid) {
      await assert.rejects(
        archive.patchChanges([change], initial.revision, actor),
      );
      assert.deepEqual(await archive.read(), initial);
    }
    const first = await archive.patchChanges(
      [
        {
          collection: "people",
          id: "father",
          field: "events",
          after: [{ id: "work", type: "work", date: "1980" }],
          before: undefined,
        },
      ],
      initial.revision,
      actor,
    );
    const second = await archive.patchChanges(
      [
        {
          collection: "people",
          id: "child",
          field: "sources",
          after: [{ title: "Источник", type: "", reference: "" }],
          before: [],
        },
      ],
      initial.revision,
      actor,
    );
    assert.equal(second.revision, first.revision + 1);
    await assert.rejects(
      archive.patchChanges(
        [
          {
            collection: "people",
            id: "father",
            field: "events",
            after: [],
            before: undefined,
          },
        ],
        initial.revision,
        actor,
      ),
      /обновлены/,
    );
    assert.equal(
      (await archive.read()).family.people[0].events?.[0].id,
      "work",
    );
  } finally {
    await archive.close();
  }
});

test("scoped deltas allow visible album media but deny hidden media, foreign cards and confidence escalation", async () => {
  const family = seed();
  family.people = [
    person("anchor", "1950", "member"),
    person("own", "1980", "member"),
    person("hidden", "1950", "owner"),
  ];
  family.photos = [
    {
      id: "visible-photo",
      url: "/media/visible.png",
      title: "Доступно",
      createdBy: "owner",
      tags: [{ id: "v", personId: "anchor", x: 0, y: 0, width: 1, height: 1 }],
    },
    {
      id: "hidden-photo",
      url: "/media/hidden.png",
      title: "Скрыто",
      createdBy: "owner",
      tags: [{ id: "h", personId: "hidden", x: 0, y: 0, width: 1, height: 1 }],
    },
  ];
  const archive = await openArchive(":memory:", family);
  try {
    const users = await userStore(archive.db);
    await users.register("owner", "Владелец");
    await users.register("member", "Участник");
    await archive.db
      .prepare(
        "UPDATE users SET role='relative',approved=1,person_id='anchor',tree_access='common_ancestors' WHERE id='member'",
      )
      .run();
    const member = (await users.get("member"))!;
    const initial = await archive.read();
    const saved = await archive.patchChanges(
      [
        {
          collection: "people",
          id: "own",
          field: "photo",
          before: undefined,
          after: "/media/visible.png",
        },
      ],
      initial.revision,
      member,
    );
    const valid = await archive.read();
    for (const change of [
      {
        collection: "people" as const,
        id: "own",
        field: "sources",
        before: [],
        after: [
          {
            title: "Скрытый источник",
            type: "",
            reference: "",
            url: "/media/hidden.png",
          },
        ],
      },
      {
        collection: "people" as const,
        id: "hidden",
        field: "events",
        before: undefined,
        after: [{ id: "work", type: "work", date: "1980" }],
      },
      {
        collection: "people" as const,
        id: "own",
        field: "birthDateClaim",
        before: undefined,
        after: {
          value: "1980",
          confidence: "confirmed",
          sources: [{ title: "Источник", type: "", reference: "" }],
        },
      },
    ]) {
      await assert.rejects(
        archive.patchChanges([change], saved.revision, member),
        ForbiddenError,
      );
      assert.deepEqual(await archive.read(), valid);
    }
  } finally {
    await archive.close();
  }
});
