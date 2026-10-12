import test from "node:test";
import assert from "node:assert/strict";
import { openArchive } from "../src/server/database.ts";
import { aiChatStore } from "../src/server/ai-chats.ts";
import { mergeChatDelta, chatPollDelay } from "../src/domain/ai-chat-polling.ts";
const emptyArchive = { title: "Test", description: "", demo: false, people: [] };

test("long chat opens a bounded latest page, older pages remain accessible, edits advance a committed cursor", async () => {
  const archive = await openArchive(":memory:", emptyArchive);
  try {
    const chats = aiChatStore(archive.db);
    const chat = await chats.create("owner", "all");
    await archive.db.transaction(async () => {
      for (let index = 0; index < 235; index++) await chats.append(chat.id, index % 2 ? "assistant" : "user", `Message ${index}`);
      await chats.append(chat.id, "user", "Private internal prompt", { hidden: true });
    });
    const first = (await chats.historyPage(chat.id, "owner"))!;
    assert.equal(first.messages.length, 100);
    assert.equal(first.messages[0].content, "Message 135");
    assert.equal(first.messages.at(-1)!.content, "Message 234");
    assert.equal(first.hasMore, true);
    const second = (await chats.historyPage(chat.id, "owner", first.nextBefore!))!;
    const third = (await chats.historyPage(chat.id, "owner", second.nextBefore!))!;
    assert.equal(third.messages.length, 35);
    assert.equal(third.nextBefore, null);
    assert.equal(new Set([...third.messages, ...second.messages, ...first.messages].map(message => message.id)).size, 235);
    assert.equal(await chats.historyPage(chat.id, "other"), null);
    const before = (await chats.head(chat.id, "owner"))!;
    await archive.db.prepare("UPDATE ai_chat_messages SET data=? WHERE id=?").run(JSON.stringify({ suggestionIds: ["updated-proposal"] }), first.messages[0].id);
    const delta = (await chats.changesAfter(chat.id, "owner", before.version))!;
    assert.equal(delta.messages.length, 1);
    assert.equal(delta.messages[0].id, first.messages[0].id);
    assert.deepEqual(delta.messages[0].suggestionIds, ["updated-proposal"]);
    assert.ok(delta.lastVersion > before.version);
    await archive.db.prepare("UPDATE ai_chat_messages SET data=? WHERE id=?").run(JSON.stringify({ hidden: true, attachments: [{ private: "data" }] }), first.messages[0].id);
    const hidden = (await chats.changesAfter(chat.id, "owner", delta.lastVersion))!;
    assert.deepEqual(hidden.messages[0], { id: first.messages[0].id, version: hidden.lastVersion, role: first.messages[0].role, content: "", hidden: true });
    assert.equal((await chats.messages(chat.id, "owner", true))!.some(message => "id" in message || "version" in message), false, "provider history never receives transport metadata");
  } finally { await archive.close(); }
});

test("delta replaces old metadata, reconciles optimistic messages, ignores unloaded old pages and removes hidden rows", () => {
  type Message = { id?: number; version?: number; role: string; content: string; hidden?: boolean; activities?: string[]; suggestionIds?: string[] };
  const current: Message[] = [{ id: 200, version: 2, role: "assistant", content: "Answer", activities: ["Search"] }, { role: "user", content: "Next" }];
  const next = mergeChatDelta(current, [{ id: 1, version: 3, role: "user", content: "Unloaded old record" }, { id: 200, version: 4, role: "assistant", content: "Answer", suggestionIds: ["reviewed"] }, { id: 201, version: 5, role: "user", content: "Next" }]);
  assert.deepEqual(next.map(message => message.id), [200, 201]);
  assert.deepEqual(next[0].suggestionIds, ["reviewed"]);
  assert.deepEqual(next[0].activities, ["Search"]);
  const older = mergeChatDelta(next, [{ id: 1, version: 3, role: "user", content: "Older" }], true);
  assert.deepEqual(older.map(message => message.id), [1, 200, 201]);
  assert.deepEqual(mergeChatDelta(older, [{ id: 200, version: 6, role: "assistant", content: "", hidden: true }]).map(message => message.id), [1, 201]);
  assert.equal(mergeChatDelta(next, []), next);
  assert.equal(chatPollDelay(true), 2000);
  assert.equal(chatPollDelay(false), 30000);
  assert.equal(chatPollDelay(false, 8), 60000);
});

test("proposal review updates message cursors across clients and rolls back with its transaction", async () => {
  const archive = await openArchive(":memory:", emptyArchive);
  try {
    const chats = aiChatStore(archive.db);
    const chat = await chats.create("owner", "all");
    await archive.db.prepare("INSERT INTO research_suggestions(id,kind,status,person_id,payload,reason,evidence,base_revision,created_at,created_by) VALUES(?,'person_update','pending','person','{}','','[]',1,'2026-10-12','owner')").run("proposal");
    await chats.append(chat.id, "assistant", "Confirm the change", { suggestionIds: ["proposal"] });
    const before = (await chats.head(chat.id, "owner"))!;
    await assert.rejects(archive.db.transaction(async () => {
      await archive.db.prepare("UPDATE research_suggestions SET status='accepted' WHERE id='proposal'").run();
      throw new Error("rollback");
    }), /rollback/);
    assert.equal((await chats.head(chat.id, "owner"))!.version, before.version);
    assert.equal((await chats.historyPage(chat.id, "owner"))!.messages[0].suggestionStatuses?.proposal, "pending");
    await archive.db.prepare("UPDATE research_suggestions SET status='rejected' WHERE id='proposal'").run();
    const changes = (await chats.changesAfter(chat.id, "owner", before.version))!;
    assert.equal(changes.messages.length, 1);
    assert.equal(changes.messages[0].suggestionStatuses?.proposal, "rejected");
    assert.ok(changes.lastVersion > before.version);
    assert.equal((await chats.historyPage(chat.id, "owner"))!.messages[0].suggestionStatuses?.proposal, "rejected");
  } finally { await archive.close(); }
});

test("history bounds JSON body allocation and a huge hidden prompt produces only a small tombstone", async () => {
  const archive = await openArchive(":memory:", emptyArchive);
  try {
    const chats = aiChatStore(archive.db);
    const chat = await chats.create("owner", "all");
    await chats.append(chat.id, "assistant", "a".repeat(2 * 1024 ** 2));
    await chats.append(chat.id, "assistant", "b".repeat(2 * 1024 ** 2));
    const page = (await chats.historyPage(chat.id, "owner"))!;
    assert.equal(page.messages.length, 1);
    assert.equal(page.hasMore, true);
    const before = (await chats.head(chat.id, "owner"))!;
    await chats.append(chat.id, "user", "private".repeat(2 * 1024 ** 2), { hidden: true });
    const delta = (await chats.changesAfter(chat.id, "owner", before.version))!;
    assert.equal(delta.messages.length, 1);
    assert.equal(delta.messages[0].hidden, true);
    assert.equal(delta.messages[0].content, "");
    assert.ok(JSON.stringify(delta).length < 512);
  } finally { await archive.close(); }
});
