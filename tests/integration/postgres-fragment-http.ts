import assert from "node:assert/strict";
import type { openArchive } from "../../src/server/database.ts";
import type { Family, Person } from "../../src/domain/types.ts";
import { validateFamily } from "../../src/domain/validation.ts";
import {
  newSessionToken,
  sessionTokenHash,
} from "../../src/server/session-token.ts";

type Archive = Awaited<ReturnType<typeof openArchive>>;

/** Independent live protocol check: real PostgreSQL projection SQL, ordinary
 * FORCE-RLS role and authenticated scoped sessions, never production records. */
export async function verifyPostgresFragmentHttp(
  archive: Archive,
  base: string,
  memberToken: string,
) {
  const people: Person[] = Array.from({ length: 1001 }, (_, i) => ({
    id: `p-${i}`,
    name: `Person ${i}`,
    surname: "Тест",
    patronymic: "",
    sex: "m",
    birth: i === 0 ? "1950" : "1980",
    birthPlace: "",
    parents: i > 0 && i < 1000 ? ["p-0"] : [],
    spouses: [],
    generation: i ? 2 : 1,
    column: i,
    sources: [],
    createdBy: "owner",
    biography: "PRIVATE-BIOGRAPHY " + "Подробности. ".repeat(200),
  }));
  const family: Family = {
    title: "PG фрагменты",
    description: "",
    demo: false,
    people,
    photos: [],
    links: [],
  };
  const old = await archive.read();
  await archive.db
    .prepare(
      "",
      "UPDATE account_tiers SET full_access=true WHERE account_id='owner'",
    )
    .run();
  await archive.write(family, old.revision, undefined, {
    knownPrevious: old.family,
  });
  await archive.db
    .prepare(
      "",
      "UPDATE archive_memberships SET person_id='p-700' WHERE user_id='scoped-member'",
    )
    .run();
  const read = archive.read,
    overview = archive.overview,
    scopedOverview = archive.scopedOverview;
  archive.read = async () => {
    throw new Error("Unexpected full snapshot during fragment protocol");
  };
  archive.overview = async () => {
    throw new Error("Unexpected full overview during fragment protocol");
  };
  archive.scopedOverview = async () => {
    throw new Error("Unexpected full scoped overview during fragment protocol");
  };
  const auth = (token = memberToken) => ({ Cookie: `drevo_session=${token}` });
  const endpoint = `${base}/api/family`;
  try {
    const started = performance.now();
    const response = await fetch(`${endpoint}?projection=overview`, {
      headers: {
        ...auth(),
        "X-Drevo-Fragment": "auto",
        "X-Drevo-Fragment-Anchor": "p-0",
      },
    });
    assert.equal(response.status, 200, await response.clone().text());
    const initial = await response.json();
    validateFamily(initial.family);
    assert.equal(initial.family.people.length, 500);
    assert.equal(
      initial.totals.people,
      1000,
      "the private 1001st person cannot contribute to totals",
    );
    assert.equal(initial.fragment.total, 1000);
    assert.equal(initial.fragment.referenceId, "p-700");
    assert.ok(
      !initial.fragment.peopleIds.includes("p-700"),
      "reference must be outside this emitted window",
    );
    assert.equal(initial.fragment.relationLabels["p-0"], "Отец");
    assert.equal(Object.keys(initial.fragment.relationLabels).length, 500);
    assert.equal(
      initial.fragment.hidden.find(([id]: [string]) => id === "p-0")[1],
      500,
    );
    assert.doesNotMatch(
      JSON.stringify(initial),
      /PRIVATE-BIOGRAPHY|"id":"p-1000"/,
    );
    const fragment = (body: unknown, token = initial.pageToken) =>
      fetch(
        `${endpoint}?projection=fragment&token=${encodeURIComponent(token)}`,
        {
          method: "POST",
          headers: { ...auth(), "Content-Type": "application/json" },
          body: JSON.stringify(body),
        },
      );
    const visited = new Set<string>(initial.fragment.peopleIds);
    let previous = initial.fragment;
    for (let turn = 0; turn < 2; turn++) {
      const nextResponse = await fragment({
        anchorId: "p-0",
        ancestors: 3,
        descendants: 3,
        collateral: 1,
        previous: previous.peopleIds,
        offset: previous.nextOffset,
      });
      assert.equal(nextResponse.status, 200, await nextResponse.clone().text());
      const next = await nextResponse.json();
      validateFamily(next.family);
      assert.equal(next.family.people.length, 500);
      assert.equal(next.totals.people, 1000);
      assert.doesNotMatch(
        JSON.stringify(next),
        /PRIVATE-BIOGRAPHY|"id":"p-1000"/,
      );
      for (const id of next.fragment.peopleIds) visited.add(id);
      previous = next.fragment;
    }
    assert.equal(
      visited.size,
      1000,
      "navigation visits omitted children rather than replaying the same window",
    );
    for (const anchorId of ["p-1000", "not-present"]) {
      const denied = await fragment({
        anchorId,
        ancestors: 3,
        descendants: 3,
        collateral: 1,
      });
      assert.equal(denied.status, 404);
      assert.equal(
        (await denied.json()).error,
        "Человек не найден или недоступен",
      );
    }
    const forged = await fragment({
      anchorId: "p-0",
      ancestors: 3,
      descendants: 3,
      collateral: 1,
      previous: ["p-1000"],
    });
    assert.equal(forged.status, 404);
    assert.equal(
      (
        await fragment(
          { anchorId: "p-0", ancestors: 3, descendants: 3, collateral: 1 },
          "old-token",
        )
      ).status,
      409,
    );
    console.log(
      "bounded_fragment_pg_metrics",
      JSON.stringify({
        archivePeople: 1001,
        authorizedPeople: 1000,
        initialPeople: 500,
        threeWindowPeople: visited.size,
        milliseconds: Math.round(performance.now() - started),
        initialUtf8Bytes: Buffer.byteLength(JSON.stringify(initial)),
        referenceOutsideWindow: true,
      }),
    );

    // A tiny authorized scope must not disclose that the full archive passed
    // the automatic threshold, nor force the otherwise unnecessary fragment.
    archive.scopedOverview = scopedOverview;
    await archive.db.transaction(async () => {
      await archive.db
        .prepare(
          "",
          "INSERT INTO accounts(id,name,created_at) VALUES('small-reader','Читатель',?)",
        )
        .run(new Date().toISOString());
      await archive.db
        .prepare(
          "",
          "INSERT INTO archive_memberships(archive_id,user_id,role,approved,person_id,tree_access) VALUES(current_setting('drevo.archive_id'),'small-reader','reader',true,'p-1000','common_ancestors')",
        )
        .run();
    });
    const readerToken = newSessionToken();
    await archive.db
      .prepare(
        "",
        "INSERT INTO account_sessions(token_hash,user_id,expires_at) VALUES(?,'small-reader',?)",
      )
      .run(sessionTokenHash(readerToken), Date.now() + 60_000);
    const smallResponse = await fetch(
      `${endpoint}?projection=overview&fragment=auto`,
      { headers: auth(readerToken) },
    );
    assert.equal(smallResponse.status, 200, await smallResponse.clone().text());
    const small = await smallResponse.json();
    assert.equal(small.fragment, undefined);
    assert.equal(small.totals.people, 1);
    assert.deepEqual(
      small.family.people.map((person: Person) => person.id),
      ["p-1000"],
    );
    console.log("bounded_fragment_pg_scoped_protocol_ok");
  } finally {
    archive.read = read;
    archive.overview = overview;
    archive.scopedOverview = scopedOverview;
  }
}
