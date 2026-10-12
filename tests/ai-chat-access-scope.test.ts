import assert from "node:assert/strict";
import test from "node:test";
import type { ArchiveUser } from "../src/domain/access.ts";
import type { Family } from "../src/domain/types.ts";
import {
  aiChatAccessScope,
  aiChatAllowedScopes,
} from "../src/server/ai-chat-access-scope.ts";
import {
  aiChatAccessScopeFromIds,
  aiChatAllowedScopesFromCurrent,
} from "../src/server/ai-chat-access-scope.ts";
import { projectFamilyForUser } from "../src/domain/tree-access.ts";
import type { Person } from "../src/domain/types.ts";

const family: Family = {
  title: "Synthetic",
  description: "",
  demo: false,
  people: [],
  photos: [],
  links: [],
  unions: [],
};
const member = (changes: Partial<ArchiveUser> = {}): ArchiveUser => ({
  id: "member",
  name: "Synthetic",
  createdAt: "2026-01-01",
  approved: true,
  role: "relative",
  treeRole: "relative",
  globalRole: null,
  archiveOwner: false,
  treeAccess: "all",
  ...changes,
});

test("AI history keeps a former owner's admin scope without granting a staff role", () => {
  const owner = member({ archiveOwner: true });
  assert.equal(aiChatAccessScope(owner), JSON.stringify(["admin", "all", ""]));
  assert.equal(owner.globalRole, null);
});

test("former researcher history remains visible only with identical local scope", () => {
  const current = member({ personId: "self", treeAccess: "common_ancestors" });
  const scopes = aiChatAllowedScopes(current, family);
  assert.ok(
    scopes.includes(
      JSON.stringify([
        "researcher",
        "common_ancestors",
        "self",
        JSON.parse(scopes[0]).at(-1),
      ]),
    ),
  );
  assert.ok(
    !scopes.includes(
      JSON.stringify([
        "researcher",
        "common_ancestors",
        "other",
        JSON.parse(scopes[0]).at(-1),
      ]),
    ),
  );
  assert.ok(
    !scopes.some((scope) => JSON.parse(scope)[0] === "admin"),
    "old admin chats bypassed scoped projection and cannot be aliased to it",
  );
});

test("old unscoped admin history can be read with a full-tree relative grant", () => {
  const scopes = aiChatAllowedScopes(member());
  assert.ok(scopes.includes(JSON.stringify(["admin", "all", ""])));
  assert.ok(
    !aiChatAllowedScopes(
      member({ role: "reader", treeRole: "reader" }),
    ).includes(JSON.stringify(["admin", "all", ""])),
  );
});

test("SQLite role changes retain their existing history boundary", () => {
  const local = member({ treeRole: undefined, globalRole: undefined });
  assert.deepEqual(aiChatAllowedScopes(local), [
    JSON.stringify(["relative", "all", ""]),
  ]);
});

test("thin visible IDs preserve chat history fingerprints and historical-role aliases", () => {
  const current = member({ personId: "self", treeAccess: "common_ancestors" });
  const person = (id: string, createdBy?: string): Person => ({
    id,
    name: id,
    surname: "",
    patronymic: "",
    sex: "u",
    birth: "",
    birthPlace: "",
    generation: 1,
    column: 0,
    parents: [],
    spouses: [],
    sources: [],
    createdBy,
  });
  const data: Family = {
    ...family,
    people: [person("self"), person("own", current.id), person("hidden")],
    photos: [
      {
        id: "tagged",
        url: "media/tagged.jpg",
        title: "Tagged",
        place: "",
        description: "",
        tags: [
          { id: "tag", personId: "self", x: 0, y: 0, width: 1, height: 1 },
        ],
      },
      {
        id: "owned",
        url: "media/owned.jpg",
        title: "Owned",
        place: "",
        description: "",
        tags: [],
        createdBy: current.id,
      },
      {
        id: "secret",
        url: "media/secret.jpg",
        title: "Hidden",
        place: "",
        description: "",
        tags: [],
      },
    ],
  };
  const visible = projectFamilyForUser(data, current);
  const fromIds = aiChatAccessScopeFromIds(
    current,
    visible.people.map((item) => item.id).reverse(),
    (visible.photos || []).map((item) => item.id).reverse(),
  );
  assert.equal(fromIds, aiChatAccessScope(current, data));
  assert.deepEqual(
    aiChatAllowedScopesFromCurrent(current, fromIds),
    aiChatAllowedScopes(current, data),
  );
  assert.notEqual(
    aiChatAccessScopeFromIds(
      current,
      visible.people.map((item) => item.id),
      [],
    ),
    fromIds,
    "photo access remains part of the fingerprint",
  );
});
