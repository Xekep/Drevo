import assert from "node:assert/strict";
import type { openArchive } from "../../src/server/database.ts";

/** The real HTTP/SQL boundary for on-demand profiles and tagged photographs. */
export async function assertPostgresDemandDetails(
  base: string,
  archive: Awaited<ReturnType<typeof openArchive>>,
  userId: string,
) {
  const snapshot = await archive.read();
  const overview = await fetch(base + "/api/family?projection=overview").then(
    (r) => r.json(),
  );
  const person = snapshot.family.people[0];
  const path =
    base +
    "/api/family?" +
    new URLSearchParams({
      projection: "details",
      ids: JSON.stringify([person.id]),
      offset: "0",
      token: overview.pageToken,
    });
  const response = await fetch(path);
  assert.equal(response.status, 200, await response.clone().text());
  const body = await response.json();
  assert.equal(body.pageToken, overview.pageToken);
  assert.deepEqual(
    body.people.map((p: { id: string }) => p.id),
    [person.id],
  );
  assert.equal(body.people[0].biography, person.biography);
  const photos = (snapshot.family.photos || []).filter((photo) =>
    photo.tags.some((tag) => tag.personId === person.id),
  );
  assert.equal(body.photoTotal, photos.length);
  assert.deepEqual(
    body.photos.map((photo: { id: string }) => photo.id).sort(),
    photos
      .slice(0, 40)
      .map((photo) => photo.id)
      .sort(),
  );
  assert.equal(
    await archive.photoCount(
      { visible: new Set([person.id]), userId },
      new Set([person.id]),
    ),
    photos.length,
  );
  assert.equal(
    (
      await fetch(
        path.replace(
          encodeURIComponent(overview.pageToken),
          encodeURIComponent("stale-token"),
        ),
      )
    ).status,
    409,
  );
  assert.equal(
    (
      await fetch(
        base +
          "/api/family?" +
          new URLSearchParams({
            projection: "details",
            ids: JSON.stringify(["missing-detail-person"]),
            token: overview.pageToken,
          }),
      )
    ).status,
    404,
  );
}
