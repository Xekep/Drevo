import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { openArchive } from "../src/server/database.ts";
import { aiChatStore } from "../src/server/ai-chats.ts";
import { aiChatFollowups, FollowupError } from "../src/server/ai-chat-followups.ts";

const fixture = async () => {
  const archive = await openArchive(":memory:", { title: "Test", description: "", demo: false, people: [] });
  const chats = aiChatStore(archive.db);
  const chat = await chats.create("owner", "scope");
  const token = (await chats.acquire(chat.id))!;
  return { archive, chats, chat, token, followups: aiChatFollowups(archive.db, chats) };
};
const status = (value: number) => (error: unknown) => error instanceof FollowupError && error.status === value;

test("followups are visible, ordered, idempotent, and private state survives finalization", async () => {
  const { archive, chats, chat, token, followups } = await fixture();
  try {
    const firstId = randomUUID();
    const first = await followups.enqueue(chat.id, "owner", firstId, "Первая поправка", async scope => scope === "scope");
    assert.equal(first.duplicate, false);
    assert.ok(first.message?.id);
    assert.deepEqual(await followups.enqueue(chat.id, "owner", firstId, "Первая поправка", async () => true), { ...first, duplicate: true });
    await assert.rejects(followups.enqueue(chat.id, "owner", firstId, "Иной текст", async () => true), status(409));
    await followups.enqueue(chat.id, "owner", randomUUID(), "Вторая поправка", async () => true);
    assert.deepEqual(await followups.take(chat.id, "owner", token, true), ["Первая поправка", "Вторая поправка"]);
    assert.deepEqual(await followups.take(chat.id, "owner", token, true), []);
    await chats.setActivePeople(chat.id, ["person"]);
    assert.deepEqual((await chats.read(chat.id, "owner"))!.sessionState, { schemaVersion: 1, activePersonIds: ["person"] });
    await assert.rejects(followups.enqueue(chat.id, "owner", randomUUID(), "Поздняя", async () => true), status(409));
    await chats.release(chat.id, token);
    assert.equal((await followups.enqueue(chat.id, "owner", firstId, "Первая поправка", async () => true)).duplicate, true);
    assert.deepEqual((await chats.messages(chat.id, "owner"))!.map(item => item.content), ["Первая поправка", "Вторая поправка"]);
  } finally { await archive.close(); }
});

test("followup admission checks ownership, current access, stop, expired lease and input bounds", async () => {
  const { archive, chats, chat, token, followups } = await fixture();
  try {
    await assert.rejects(followups.enqueue(chat.id, "other", randomUUID(), "Текст", async () => true), status(404));
    await assert.rejects(followups.enqueue(chat.id, "owner", randomUUID(), "Текст", async () => false), status(403));
    for (const [id, text] of [["bad", "Текст"], [randomUUID(), " "], [randomUUID(), "x".repeat(8001)]])
      await assert.rejects(followups.enqueue(chat.id, "owner", id, text, async () => true), status(400));
    await chats.requestStop(chat.id, "owner");
    await assert.rejects(followups.enqueue(chat.id, "owner", randomUUID(), "Текст", async () => true), status(409));
    await assert.rejects(followups.take(chat.id, "owner", token), { name: "AbortError" });
    await chats.release(chat.id, token);
    const next = (await chats.acquire(chat.id))!;
    await archive.db.prepare("UPDATE ai_chats SET busy_until=? WHERE id=?").run(Date.now() - 1, chat.id);
    await assert.rejects(followups.enqueue(chat.id, "owner", randomUUID(), "Текст", async () => true), status(409));
    await assert.rejects(followups.take(chat.id, "owner", next), { name: "AbortError" });
    assert.equal((await chats.messages(chat.id, "owner"))!.length, 0);
  } finally { await archive.close(); }
});

test("followup count and characters remain bounded after draining; a new turn resets its budget", async () => {
  const { archive, chats, chat, token, followups } = await fixture();
  try {
    for (let i = 0; i < 8; i++) {
      await followups.enqueue(chat.id, "owner", randomUUID(), `Поправка ${i}`, async () => true);
      await followups.take(chat.id, "owner", token);
    }
    await assert.rejects(followups.enqueue(chat.id, "owner", randomUUID(), "Девятая", async () => true), status(429));
    await chats.release(chat.id, token);
    const next = (await chats.acquire(chat.id))!;
    for (let i = 0; i < 3; i++) await followups.enqueue(chat.id, "owner", randomUUID(), "x".repeat(8000), async () => true);
    await assert.rejects(followups.enqueue(chat.id, "owner", randomUUID(), "x", async () => true), status(429));
    await assert.rejects(followups.take(chat.id, "owner", token), { name: "AbortError" });
    assert.equal((await followups.take(chat.id, "owner", next)).length, 3);
  } finally { await archive.close(); }
});

test("separate inbox instances serialize concurrent admission and final sealing", async () => {
  const { archive, chats, chat, token, followups } = await fixture();
  try {
    const other = aiChatFollowups(archive.db, chats);
    const id = randomUUID();
    const results = await Promise.all([
      followups.enqueue(chat.id, "owner", id, "Одна поправка", async () => true),
      other.enqueue(chat.id, "owner", id, "Одна поправка", async () => true),
    ]);
    assert.equal(results.filter(item => !item.duplicate).length, 1);
    const [taken, admitted] = await Promise.all([
      followups.take(chat.id, "owner", token, true),
      other.enqueue(chat.id, "owner", randomUUID(), "Последняя поправка", async () => true),
    ]);
    assert.deepEqual(taken, ["Одна поправка"]);
    assert.equal(admitted.accepted, true, "draining nonempty inbox does not seal out accepted work");
    assert.deepEqual(await followups.take(chat.id, "owner", token, true), ["Последняя поправка"]);
    await other.take(chat.id, "owner", token, true);
    await assert.rejects(followups.enqueue(chat.id, "owner", randomUUID(), "Слишком поздно", async () => true), status(409));
  } finally { await archive.close(); }
});
