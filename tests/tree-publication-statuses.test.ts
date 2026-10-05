import test from "node:test";
import assert from "node:assert/strict";
import { TreePublicationStatuses } from "../src/components/tree/tree-publication-statuses.ts";

const tick = () => new Promise<void>((resolve) => setImmediate(resolve));

test("visible cards batch and deduplicate reads, including repeated occurrences", async () => {
  const calls: string[][] = [];
  const cache = new TreePublicationStatuses("/api/archives/a/admin/published-people/batch", async (input) => {
    const url = new URL(String(input), "http://localhost");
    assert.equal(url.pathname, "/api/archives/a/admin/published-people/batch");
    calls.push(url.searchParams.getAll("id"));
    return Response.json({ fields: { "person-0": {} } });
  });
  cache.start();
  const unsubscribes = Array.from({ length: 105 }, (_, index) => cache.subscribe(`person-${index}`, () => {}));
  unsubscribes.push(cache.subscribe("person-0", () => {}));
  const offscreen = cache.subscribe("offscreen", () => {});
  offscreen();
  await tick();
  assert.deepEqual(calls.map((ids) => ids.length), [50, 50, 5]);
  assert.equal(calls.flat().filter((id) => id === "person-0").length, 1);
  assert.equal(calls.flat().includes("offscreen"), false);
  assert.equal(cache.get("person-0"), "published");
  assert.equal(cache.get("person-1"), "hidden");
  cache.refresh("person-0");
  await tick();
  assert.equal(calls.length, 3);
  unsubscribes.forEach((unsubscribe) => unsubscribe());
  cache.stop();
});

test("failed or malformed reads remain errors, never falsely mark people hidden", async () => {
  for (const response of [Response.json({ error: "Forbidden" }, { status: 403 }), Response.json({})]) {
    const cache = new TreePublicationStatuses("/batch", async () => response);
    cache.start();
    cache.subscribe("person", () => {});
    await tick();
    assert.equal(cache.get("person"), "error");
    cache.stop();
  }
});

test("a confirmed dialog update wins over a delayed batch response", async () => {
  let resolve!: (response: Response) => void;
  const cache = new TreePublicationStatuses("/batch", () => new Promise<Response>((done) => { resolve = done; }));
  cache.start();
  cache.subscribe("person", () => {});
  await tick();
  assert.equal(cache.get("person"), "loading");
  cache.update("person", true);
  resolve(Response.json({ fields: {} }));
  await tick();
  assert.equal(cache.get("person"), "published");
  cache.stop();
});

test("canvas cleanup aborts old reads and restart reads again", async () => {
  const pending: { resolve: (response: Response) => void; signal: AbortSignal }[] = [];
  const cache = new TreePublicationStatuses("/batch", (_input, init) =>
    new Promise<Response>((resolve) => { pending.push({ resolve, signal: init!.signal as AbortSignal }); }));
  cache.start();
  cache.subscribe("person", () => {});
  await tick();
  cache.stop();
  assert.equal(pending[0].signal.aborted, true);
  cache.start();
  await tick();
  pending[0].resolve(Response.json({ fields: { person: {} } }));
  await tick();
  assert.equal(cache.get("person"), "loading");
  pending[1].resolve(Response.json({ fields: {} }));
  await tick();
  assert.equal(cache.get("person"), "hidden");
  cache.stop();
});
