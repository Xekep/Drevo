import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { additionsImportHttp } from "../src/server/additions-import-http.ts";
import { openArchive } from "../src/server/database.ts";
import type { Family, ArchiveUser } from "../src/domain/index.ts";

test("HTTP preview/apply enforces admin, origin, reviewed payload, stale revisions, atomic creation and preservation", async () => {
  const family: Family = {
    title: "Test",
    description: "",
    demo: false,
    people: [
      {
        id: "old",
        name: "Иван",
        surname: "Пример",
        patronymic: "",
        sex: "m",
        birth: "1870",
        birthPlace: "",
        needsReview: false,
        parents: [],
        spouses: [],
        generation: 1,
        column: 0,
        sources: [],
      },
    ],
  };
  const archive = await openArchive(":memory:", family);
  let actor: ArchiveUser | null = {
    id: "admin",
    name: "Admin",
    role: "admin",
    createdAt: "",
  };
  const auth = { currentUser: async () => actor };
  const route = additionsImportHttp({
    archive,
    auth,
    publicOrigin: "https://test.invalid",
  });
  const server = createServer(async (req, res) => {
    if (!(await route(req, res, new URL(req.url!, "https://test.invalid")))) {
      res.writeHead(404);
      res.end();
    }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}/api/import/additions/`;
  const packet = {
    format: "drevo.reviewed-add-only",
    version: 1,
    newPeople: [
      {
        ...family.people[0],
        id: "new",
        name: "Пётр",
        birth: "1900",
        parents: ["old"],
      },
    ],
  };
  const request = (
    path: string,
    body: unknown,
    origin = "https://test.invalid",
  ) =>
    fetch(base + path, {
      method: "POST",
      headers: { Origin: origin, "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  try {
    const initial = await archive.read();
    assert.equal(
      (await request("preview", { package: packet }, "https://evil.invalid"))
        .status,
      403,
    );
    actor = null;
    assert.equal((await request("preview", { package: packet })).status, 401);
    actor = { id: "reader", name: "Reader", role: "reader", createdAt: "" };
    assert.equal((await request("preview", { package: packet })).status, 403);
    actor = { id: "admin", name: "Admin", role: "admin", createdAt: "" };
    const response = await request("preview", { package: packet });
    assert.equal(response.status, 200);
    const preview = await response.json();
    assert.deepEqual(await archive.read(), initial);
    const apply = {
      package: packet,
      revision: preview.revision,
      fingerprint: preview.fingerprint,
      confirm: true,
    };
    assert.equal(
      (await request("apply", { ...apply, fingerprint: "bad" })).status,
      409,
    );
    const modified = structuredClone(packet);
    modified.newPeople[0].name = "Подмена";
    assert.equal(
      (await request("apply", { ...apply, package: modified })).status,
      409,
    );
    actor = { ...actor, role: "relative" };
    assert.equal((await request("apply", apply)).status, 403);
    actor = { ...actor, role: "admin" };
    const newer = structuredClone(initial.family);
    newer.people[0].biography = "Чужая правка";
    await archive.write(newer, initial.revision);
    assert.equal((await request("apply", apply)).status, 409);
    const checked = await (
      await request("preview", { package: packet })
    ).json();
    const concurrent = {
      ...apply,
      revision: checked.revision,
      fingerprint: checked.fingerprint,
    };
    const replies = await Promise.all([
      request("apply", concurrent),
      request("apply", concurrent),
    ]);
    assert.deepEqual(replies.map((r) => r.status).sort(), [200, 409]);
    const saved = await archive.read();
    assert.equal(saved.family.people.length, 2);
    assert.deepEqual(saved.family.people[0], newer.people[0]);
    assert.equal(saved.family.people[1].needsReview, true);
    assert.equal(saved.family.people[1].createdBy, "admin");
    assert.equal((await request("preview", { package: packet })).status, 400);
    assert.equal(
      (await archive.db.prepare("SELECT count(*) AS n FROM history").get())!.n,
      2,
    );
    const broken = {
      ...packet,
      newPeople: [
        {
          ...packet.newPeople[0],
          id: "bad",
          birth: "1900",
          death: "1930",
          events: [{ id: "marriage", type: "marriage", date: "1940" }],
        },
      ],
    };
    const badPreview = await (
      await request("preview", { package: broken })
    ).json();
    assert(badPreview.errorCount > 0);
    assert.equal(
      (
        await request("apply", {
          package: broken,
          ...badPreview,
          confirm: true,
        })
      ).status,
      400,
    );
    assert.deepEqual(await archive.read(), saved);
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((e) => (e ? reject(e) : resolve())),
    );
    await archive.close();
  }
});
