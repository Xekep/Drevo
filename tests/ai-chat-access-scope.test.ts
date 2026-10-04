import assert from "node:assert/strict";
import test from "node:test";
import type { ArchiveUser } from "../src/domain/access.ts";
import type { Family } from "../src/domain/types.ts";
import { aiChatAccessScope, aiChatAllowedScopes } from "../src/server/ai-chat-access-scope.ts";

const family: Family = {
  title: "Synthetic", description: "", demo: false, people: [], photos: [], links: [], unions: [],
};
const member = (changes: Partial<ArchiveUser> = {}): ArchiveUser => ({
  id: "member", name: "Synthetic", createdAt: "2026-01-01", approved: true,
  role: "relative", treeRole: "relative", globalRole: null,
  archiveOwner: false, treeAccess: "all", ...changes,
});

test("AI history keeps a former owner's admin scope without granting a staff role", () => {
  const owner = member({ archiveOwner: true });
  assert.equal(aiChatAccessScope(owner), JSON.stringify(["admin", "all", ""]));
  assert.equal(owner.globalRole, null);
});

test("former researcher history remains visible only with identical local scope", () => {
  const current = member({ personId: "self", treeAccess: "common_ancestors" });
  const scopes = aiChatAllowedScopes(current, family);
  assert.ok(scopes.includes(JSON.stringify(["researcher", "common_ancestors", "self",
    JSON.parse(scopes[0]).at(-1)])));
  assert.ok(!scopes.includes(JSON.stringify(["researcher", "common_ancestors", "other",
    JSON.parse(scopes[0]).at(-1)])));
  assert.ok(!scopes.some((scope) => JSON.parse(scope)[0] === "admin"),
    "old admin chats bypassed scoped projection and cannot be aliased to it");
});

test("old unscoped admin history can be read with a full-tree relative grant", () => {
  const scopes = aiChatAllowedScopes(member());
  assert.ok(scopes.includes(JSON.stringify(["admin", "all", ""])));
  assert.ok(!aiChatAllowedScopes(member({ role: "reader", treeRole: "reader" }))
    .includes(JSON.stringify(["admin", "all", ""])));
});

test("SQLite role changes retain their existing history boundary", () => {
  const local = member({ treeRole: undefined, globalRole: undefined });
  assert.deepEqual(aiChatAllowedScopes(local), [JSON.stringify(["relative", "all", ""])]);
});
