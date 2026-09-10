import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import sharp from "sharp";
import { openArchive } from "../src/server/database.ts";
import { sharesStore } from "../src/server/shares.ts";
import { auditStore } from "../src/server/audit.ts";
import { sharedFamily } from "../src/domain/shared-family.ts";
import { importGedcom, exportGedcom } from "../src/domain/gedcom.ts";
import { startServer } from "../src/server/index.ts";
import { validateFamily } from "../src/domain/validation.ts";
import {
  archiveOverview,
  personDetails,
} from "../src/domain/archive-projection.ts";
import { hasRecordedDeath } from "../src/domain/dates.ts";
import type { Family, Person } from "../src/domain/types.ts";
import type { ArchiveUser } from "../src/domain/access.ts";
import { familyPlaces } from "../src/domain/places.ts";

const actor: ArchiveUser = {
  id: "admin",
  name: "Администратор теста",
  role: "admin",
  createdAt: "",
};
const person = (id: string, patch: Partial<Person> = {}): Person => ({
  id,
  surname: "Иванов",
  name: id,
  patronymic: "",
  sex: "u",
  birth: "",
  birthPlace: "",
  parents: [],
  spouses: [],
  sources: [],
  generation: 1,
  column: 0,
  ...patch,
});
const seed = (): Family => ({
  title: "Закрытый архив",
  description: "Секретное описание",
  demo: false,
  people: [
    person("father", { birth: "1950", spouses: ["mother"] }),
    person("mother", {
      birth: "1952",
      spouses: ["father"],
      parents: ["outside"],
    }),
    person("child", {
      birth: "1980",
      parents: ["father", "mother"],
      parentageComplete: true,
    }),
    person("outside", { birth: "1920" }),
  ],
  links: [
    {
      id: "g",
      type: "godparent",
      from: "outside",
      to: "child",
      note: "Закрытая связь",
    },
  ],
  photos: [],
});

test("share membership is fixed, excludes outside edges and metadata, token is hashed and survives reopen", () => {
  const directory = mkdtempSync(join(tmpdir(), "drevo-share-")),
    path = join(directory, "archive.sqlite");
  let archive = openArchive(path, seed());
  try {
    const shares = sharesStore(archive.db),
      now = Date.now();
    const result = shares.create(
      {
        title: "Семья",
        anchorId: "child",
        personIds: ["child", "mother"],
        durationHours: 1,
      },
      archive.read().family,
      actor,
      now,
    );
    assert.equal(result.token.length, 43);
    assert.ok(
      !JSON.stringify(
        archive.db.prepare("SELECT * FROM share_links").all(),
      ).includes(result.token),
    );
    const family = archive.read().family;
    family.people.push(person("new"));
    const projection = sharedFamily(family, result.share, result.token);
    assert.deepEqual(
      projection.people.map((p) => p.id),
      ["mother", "child"],
    );
    assert.deepEqual(projection.people[0].parents, []);
    assert.deepEqual(projection.people[1].parents, ["mother"]);
    assert.equal(projection.people[1].parentageComplete, false);
    assert.equal(projection.description, "");
    assert.deepEqual(projection.photos, []);
    assert.deepEqual(projection.links, []);
    assert.equal(shares.get(result.token, now + 3600000), null);
    archive.close();
    archive = openArchive(path, seed());
    const reopened = sharesStore(archive.db);
    assert.equal(reopened.get(result.token)?.createdName, actor.name);
    reopened.revoke(result.share.id, actor);
    assert.equal(reopened.get(result.token), null);
    assert.throws(() =>
      reopened.create(
        {
          title: "Семья",
          anchorId: "child",
          personIds: ["child"],
          durationHours: 1,
        },
        family,
        { ...actor, role: "relative" },
      ),
    );
  } finally {
    archive.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("audit keeps field values and relationship participants, remains atomic, no invented old author", () => {
  const archive = openArchive(":memory:", seed()),
    audit = auditStore(archive.db);
  try {
    assert.equal(audit.list().items.length, 0);
    const current = archive.read(),
      updated = structuredClone(current.family);
    updated.people[2].biography = "Уточнённая история";
    updated.people[2].events = [
      { id: "event", type: "residence", date: "2000", place: "Казань" },
    ];
    updated.people[2].parents = ["father"];
    archive.write(updated, current.revision, actor);
    const item = audit.list({ personId: "child" }).items[0];
    assert.equal(item.actorName, actor.name);
    assert.ok(Date.parse(item.at));
    assert.ok(
      item.details.some(
        (d) => d.field === "Биография" && d.after === "Уточнённая история",
      ),
    );
    assert.ok(
      item.details.some(
        (d) => d.field === "События жизни" && d.after.includes("Казань"),
      ),
    );
    assert.equal(audit.list({ personId: "mother" }).items[0].id, item.id);
    assert.equal(archiveOverview(updated).people[2].events, undefined);
    assert.deepEqual(
      personDetails(updated.people[2]).events,
      updated.people[2].events,
    );
    assert.equal(
      familyPlaces(updated.people).find((p) => p.name === "Казань")?.events[0]
        .kind,
      "event",
    );
    const committed = archive.read();
    archive.db.exec(
      "CREATE TRIGGER reject_audit BEFORE INSERT ON audit_entries BEGIN SELECT RAISE(ABORT,'audit unavailable'); END",
    );
    const changed = structuredClone(committed.family);
    changed.people[2].name = "Другое имя";
    assert.throws(
      () => archive.write(changed, committed.revision, actor),
      /audit unavailable/,
    );
    assert.deepEqual(archive.read(), committed);
    assert.equal(audit.list().items.length, 1);
  } finally {
    archive.close();
  }
});

test("GEDCOM round trip preserves multiple unions, parentage, events, sources, Russian names and custom kinship", () => {
  const family = seed();
  family.people.push(
    person("second", { sex: "f", spouses: ["father"] }),
    person("half", { parents: ["father", "second"] }),
  );
  family.people[0].spouses.push("second");
  family.people[0].patronymic = "Сергеевич";
  family.people[0].biography =
    "Первая строка @архив\nВторая строка " + "Длинная история ".repeat(50);
  family.people[2].events = [
    {
      id: "move",
      type: "residence",
      date: "1995-01",
      endDate: "2000",
      place: "Свердловск-44",
      description: "Историческое название",
      sources: [
        {
          title: "Домовая книга",
          type: "Архив",
          reference: "Ф.1, д.2",
          url: "https://example.org/source",
        },
      ],
    },
  ];
  family.people[1].deceased = true;
  const exported = exportGedcom(family);
  assert.ok(exported.includes("1 CHAR UTF-8"));
  assert.ok(exported.includes("2 CONC"));
  const imported = importGedcom(exported, "import").family;
  const byName = new Map(imported.people.map((p) => [p.name, p]));
  assert.equal(byName.get("father")!.patronymic, "Сергеевич");
  assert.equal(byName.get("father")!.biography, family.people[0].biography);
  assert.equal(byName.get("father")!.spouses.length, 2);
  assert.deepEqual(byName.get("child")!.events, family.people[2].events);
  assert.equal(byName.get("child")!.parents.length, 2);
  assert.equal(imported.links![0].type, "godparent");
  assert.ok(hasRecordedDeath(byName.get("mother")!));
  assert.ok(!exported.includes("createdBy"));
});

const external = `0 HEAD\n1 GEDC\n2 VERS 5.5.1\n1 CHAR UTF-8\n0 @P@ INDI\n1 NAME Пётр /Орлов/\n1 BIRT\n2 DATE 1900\n1 FAMS @F@\n0 @C@ INDI\n1 NAME Анна /Орлова/\n1 BIRT\n2 DATE ABT 1930\n1 DEAT Y\n1 FAMC @F@\n2 PEDI adopted\n1 RESI\n2 DATE FROM 1940 TO 1950\n2 PLAC Москва\n1 OBJE\n2 FILE https://example.org/private.jpg\n0 @F@ FAM\n1 HUSB @P@\n1 CHIL @C@\n0 TRLR\n`;
test("external GEDCOM preserves uncertain dates, adopted parentage, known death, and warns about media", () => {
  const result = importGedcom(external, "external"),
    child = result.family.people[1];
  assert.equal(child.birth, "");
  assert.equal(child.deceased, true);
  assert.deepEqual(child.parents, []);
  assert.equal(result.family.links![0].type, "adoptive_parent");
  assert.ok(child.events?.some((e) => e.dateText === "ABT 1930"));
  assert.ok(
    child.events?.some((e) => e.date === "1940" && e.endDate === "1950"),
  );
  assert.equal(child.photo, undefined);
  assert.ok(result.warnings.some((w) => w.includes("Файлы фотографий")));
  assert.throws(
    () => importGedcom(external.replace("UTF-8", "ANSEL"), "test"),
    /UTF-8/,
  );
  assert.equal(
    importGedcom(
      external.replace("5.5.1", "7.0").replace("1 CHAR UTF-8\n", ""),
      "version7",
    ).family.people.length,
    2,
  );
  assert.throws(
    () =>
      importGedcom(external.replace("1 CHIL @C@", "1 CHIL @MISSING@"), "test"),
    /отсутствующим/,
  );
  assert.throws(
    () => importGedcom(external.replace("0 TRLR", ""), "test"),
    /TRLR/,
  );
  const invalid = seed();
  invalid.people[0].events = [
    { id: "e", type: "residence", date: "2000", endDate: "1990" },
  ];
  assert.throws(() => validateFamily(invalid), /раньше/);
  const singleMother: Family = {
    title: "Семья",
    description: "",
    demo: false,
    people: [person("mom", { sex: "f" }), person("son", { parents: ["mom"] })],
  };
  const singleText = exportGedcom(singleMother);
  assert.ok(singleText.includes("1 WIFE @I1@"));
  assert.ok(!singleText.includes("1 HUSB"));
  assert.equal(
    importGedcom(singleText, "single").family.people[1].parents.length,
    1,
  );
});

test("HTTP share isolation, expiry, revoke, audit permissions and staged GEDCOM import", async () => {
  const directory = mkdtempSync(join(tmpdir(), "drevo-sharing-http-"));
  const keys = [
    "PUBLIC_ORIGIN",
    "YANDEX_CLIENT_ID",
    "YANDEX_CLIENT_SECRET",
    "ARCHIVE_PRIVATE",
  ];
  const env = new Map(keys.map((key) => [key, process.env[key]]));
  Object.assign(process.env, {
    PUBLIC_ORIGIN: "https://drevo.kiiko.ru",
    YANDEX_CLIENT_ID: "test",
    YANDEX_CLIENT_SECRET: "test",
    ARCHIVE_PRIVATE: "1",
  });
  const provider: typeof fetch = async (url, options) =>
    String(url).includes("/token")
      ? Response.json({
          access_token: (options!.body as URLSearchParams).get("code"),
        })
      : Response.json({
          id: (options!.headers as Record<string, string>).Authorization.slice(
            6,
          ),
          display_name: "Тестовый участник",
        });
  const app = await startServer(
    0,
    join(directory, "archive.sqlite"),
    true,
    provider,
  );
  const base = `http://127.0.0.1:${(app.server.address() as { port: number }).port}`;
  const request = (path: string, cookie = "", options: RequestInit = {}) =>
    fetch(base + path, {
      ...options,
      headers: {
        Cookie: cookie,
        Origin: "https://drevo.kiiko.ru",
        ...options.headers,
      },
    });
  async function login(id: string) {
    const start = await fetch(base + "/auth/yandex", { redirect: "manual" });
    const state = new URL(start.headers.get("location")!).searchParams.get(
      "state",
    );
    const response = await fetch(
      base + `/auth/yandex/callback?state=${state}&code=${id}`,
      {
        redirect: "manual",
        headers: { Cookie: start.headers.getSetCookie()[0].split(";")[0] },
      },
    );
    return response.headers
      .getSetCookie()
      .find((c) => c.startsWith("drevo_session="))!
      .split(";")[0];
  }
  try {
    const admin = await login("a"),
      reader = await login("b");
    const family = seed();
    const image = await sharp({
      create: { width: 20, height: 20, channels: 3, background: "white" },
    })
      .png()
      .toBuffer();
    const uploaded = await request("/api/portraits", admin, {
      method: "POST",
      headers: {
        "X-Drevo-Upload": "1",
        "If-Match": String(app.archive.read().revision),
      },
      body: image,
    });
    family.people[2].photo = (await uploaded.json()).url;
    app.archive.write(family, app.archive.read().revision);
    const issue = () =>
      request("/api/shares", admin, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "If-Match": String(app.archive.read().revision),
        },
        body: JSON.stringify({
          title: "Часть семьи",
          anchorId: "child",
          personIds: ["child", "mother"],
          durationHours: 1,
        }),
      });
    assert.equal((await request("/api/shares", reader)).status, 403);
    assert.equal((await request("/api/audit", reader)).status, 403);
    assert.equal((await request("/api/audit?personId=child")).status, 401);
    const created = await issue();
    assert.equal(created.status, 201);
    const shared = await created.json(),
      token = shared.path.split("/").at(-1);
    const page = await request(shared.path);
    assert.equal(page.status, 200);
    assert.equal(page.headers.get("referrer-policy"), "no-referrer");
    const publicData = await request(`/api/shared/${token}`);
    assert.equal(publicData.status, 200);
    assert.equal(publicData.headers.get("cache-control"), "no-store");
    const data = await publicData.json();
    assert.equal(data.family.people.length, 2);
    assert.equal(data.family.description, "");
    assert.ok(!JSON.stringify(data).includes("outside"));
    assert.deepEqual(data.family.photos, []);
    const portrait = data.family.people.find(
      (p: Person) => p.id === "child",
    ).photo;
    assert.equal((await request(portrait)).status, 200);
    assert.equal(
      (await request(`/api/shared/${token}/portrait/outside`)).status,
      404,
    );
    assert.equal((await request(family.people[2].photo!)).status, 401);
    for (const path of [
      "/api/family",
      "/api/export.json",
      "/api/people/search?q=Иванов",
      "/api/gedcom/export",
    ])
      assert.equal(
        (
          await request(
            `${path}${path.includes("?") ? "&" : "?"}share=${token}`,
          )
        ).status,
        401,
      );
    assert.equal(
      (
        await request(`/api/shares/${shared.share.id}`, admin, {
          method: "DELETE",
        })
      ).status,
      200,
    );
    assert.equal((await request(`/api/shared/${token}`)).status, 410);
    assert.equal((await request(portrait)).status, 410);
    const expired = await (await issue()).json();
    app.archive.db
      .prepare("UPDATE share_links SET expires_at=? WHERE id=?")
      .run("2000-01-01T00:00:00.000Z", expired.share.id);
    assert.equal(
      (await request(`/api/shared/${expired.path.split("/").at(-1)}`)).status,
      410,
    );
    assert.ok(
      (
        await (await request("/api/audit?personId=child", admin)).json()
      ).items.some((e: { action: string }) => e.action === "Выдана ссылка"),
    );
    const preview = () =>
      request("/api/gedcom/preview", admin, {
        method: "POST",
        headers: { "X-Drevo-Import": "1" },
        body: external,
      });
    const check = await preview();
    assert.equal(check.status, 200);
    const staged = await check.json();
    const apply = (cookie: string) =>
      request("/api/gedcom/import", cookie, {
        method: "POST",
        headers: { "X-Drevo-Import": "1", "Content-Type": "application/json" },
        body: JSON.stringify({ token: staged.token, confirm: true }),
      });
    assert.equal((await apply(reader)).status, 403);
    assert.equal((await apply(admin)).status, 200);
    assert.equal(app.archive.read().family.people.length, 6);
    assert.equal(
      app.archive.read().family.people[2].photo,
      family.people[2].photo,
    );
    assert.equal((await apply(admin)).status, 400);
    assert.ok(
      readdirSync(join(directory, "backups")).some((n) =>
        n.startsWith("before-gedcom"),
      ),
    );
    const audit = await (await request("/api/audit", admin)).json();
    assert.ok(
      audit.items.some((e: { action: string }) => e.action === "Импорт GEDCOM"),
    );
    const exportResponse = await request("/api/gedcom/export", admin);
    assert.equal(exportResponse.status, 200);
    assert.equal(
      importGedcom(await exportResponse.text(), "round-trip").family.people
        .length,
      6,
    );
  } finally {
    await app.close();
    rmSync(directory, { recursive: true, force: true });
    for (const [key, value] of env)
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
  }
});
