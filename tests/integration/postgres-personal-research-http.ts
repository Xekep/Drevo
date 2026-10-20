import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";

/** Real runtime adapter, sessions and HTTP; the ordinary PG fixture alone cannot
 * substitute for the StoreDatabase dialect and transaction boundaries. */
export async function verifyPersonalResearchHttp(
  base: string,
  ownerHeaders: HeadersInit,
  readerHeaders: HeadersInit,
) {
  const request = (
    path: string,
    body?: unknown,
    extra?: Record<string, string>,
    reader = false,
  ) => {
    const headers = new Headers(reader ? readerHeaders : ownerHeaders);
    headers.set("Content-Type", "application/json");
    for (const [key, value] of Object.entries(extra || {}))
      headers.set(key, value);
    return fetch(base + path, {
      method: body === undefined ? "GET" : "POST",
      headers,
      ...(body !== undefined && body !== null
        ? { body: JSON.stringify(body) }
        : {}),
    });
  };
  const read = async (path: string, reader = false) => {
    const response = await request(path, undefined, undefined, reader);
    assert.equal(response.status, 200, await response.clone().text());
    return response.json();
  };
  const initial = await read("/api/family");
  const person = initial.family.people[0];
  assert.ok(person, "the synthetic runtime has an accessible person");
  let filterId: string | undefined;
  try {
    const bookmark = await request("/api/bookmarks", {
      kind: "person",
      id: person.id,
      remove: false,
    });
    assert.equal(bookmark.status, 200, await bookmark.clone().text());
    assert.ok(
      (await bookmark.json()).items.some(
        (item: { id: string }) => item.id === person.id,
      ),
    );
    assert.equal((await read("/api/bookmarks", true)).items.length, 0);
    const name = `HTTP native ${randomUUID()}`;
    const saved = await request("/api/people-filters", {
      name,
      criteria: { allOf: [{ hasBirthDate: true }] },
    });
    assert.equal(saved.status, 200, await saved.clone().text());
    filterId = (await saved.json()).items.find(
      (item: { name: string }) => item.name === name,
    )?.id;
    assert.ok(filterId);
    assert.equal((await read("/api/people-filters", true)).items.length, 0);
    const filtered = await request("/api/people/filter", {
      criteria: { allOf: [{ hasBirthDate: true }] },
    });
    assert.equal(filtered.status, 200, await filtered.clone().text());
    assert.ok(Array.isArray((await filtered.json()).personIds));
    const marker = `Исследование ${randomUUID()}`;
    const changed = await request(
      "/api/family/changes",
      {
        changes: [
          {
            collection: "people",
            id: person.id,
            field: "biography",
            before: person.biography,
            after: marker,
          },
        ],
      },
      { "If-Match": String(initial.revision) },
    );
    assert.equal(changed.status, 200, await changed.clone().text());
    const revision = (await changed.json()).revision;
    const preview = await read(`/api/audit/transactions/${revision}/preview`);
    assert.equal(preview.canUndo, true, JSON.stringify(preview));
    assert.equal(
      (
        await request(
          `/api/audit/transactions/${revision}/preview`,
          undefined,
          undefined,
          true,
        )
      ).status,
      403,
    );
    const undo = await request(
      `/api/audit/transactions/${revision}/undo`,
      null,
      { "If-Match": String(preview.currentRevision) },
    );
    assert.equal(undo.status, 200, await undo.clone().text());
    assert.equal(
      (await read("/api/family")).family.people.find(
        (item: { id: string }) => item.id === person.id,
      ).biography,
      person.biography,
    );
    assert.equal(
      (
        await request(`/api/audit/transactions/${revision}/undo`, null, {
          "If-Match": String(preview.currentRevision + 1),
        })
      ).status,
      409,
    );
    console.log("runtime_personal_bookmarks_filters_and_transaction_undo_ok");
  } finally {
    await request("/api/bookmarks", {
      kind: "person",
      id: person.id,
      remove: true,
    });
    if (filterId)
      await request("/api/people-filters", { remove: true, id: filterId });
  }
}
