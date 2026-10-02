import test from "node:test";
import assert from "node:assert/strict";
import type { IncomingMessage, ServerResponse } from "node:http";
import { researchSuggestionsHttp } from "../src/server/research-suggestions-http.ts";

test("queued AI proposals are withheld after tier, role or scope changes", async () => {
  for (const change of ["unchanged", "viewer", "owner", "role", "treeAccess", "personId", "approved"] as const) {
    let viewerFull = true;
    let ownerFull = true;
    let enterList!: () => void;
    let releaseList!: () => void;
    const listEntered = new Promise<void>((resolve) => {
      enterList = resolve;
    });
    const listWait = new Promise<void>((resolve) => {
      releaseList = resolve;
    });
    const actor = {
      id: "researcher",
      approved: true,
      role: change === "treeAccess" || change === "personId" ? "researcher" : "admin",
      treeAccess: "all",
      personId: "person-1",
    };
    let currentActor = { ...actor };
    const replies: Array<{ status: number; body: string }> = [];
    let status = 0;
    const response = {
      writeHead(code: number) {
        status = code;
      },
      end(body: string) {
        replies.push({ status, body });
      },
    } as unknown as ServerResponse;
    const handler = researchSuggestionsHttp({
      archive: {
        db: {
          kind: "postgres",
          archiveId: "archive-1",
          transaction: async (work: () => Promise<boolean>) => work(),
          inTransaction: () => true,
          prepare: (_sqlite: string, postgres: string) => ({
            get: async () => postgres.includes("FROM account_sessions")
              ? { user_id: actor.id, expires_at: Date.now() + 60_000 }
              : postgres.includes("FROM archive_memberships")
                ? {
                    role: currentActor.role,
                    approved: currentActor.approved,
                    person_id: currentActor.personId,
                    tree_access: currentActor.treeAccess,
                  }
                : { viewer_full: viewerFull, owner_full: ownerFull },
          }),
        },
        read: async () => ({ family: { people: [] } }),
      },
      auth: {
        local: false,
        currentUser: async () => currentActor,
        canEdit: async () => true,
        accountSession: async () => ({ accountId: actor.id, tokenHash: "session" }),
      },
      suggestions: {
        list: async () => {
          enterList();
          await listWait;
          return [
            {
              id: "pending-ai-proposal",
              kind: "person_update",
              personId: "person-1",
              reason: "private AI result",
              payload: { changes: { name: "Private" } },
            },
          ];
        },
      },
    } as unknown as Parameters<typeof researchSuggestionsHttp>[0]);

    const request = { method: "GET" } as IncomingMessage;
    const pending = handler(
      request,
      response,
      new URL("http://localhost/api/research/suggestions"),
    );
    await listEntered;
    if (change === "viewer") viewerFull = false;
    if (change === "owner") ownerFull = false;
    if (change === "role") currentActor = { ...currentActor, role: "researcher" };
    if (change === "treeAccess")
      currentActor = { ...currentActor, treeAccess: "common_ancestors" };
    if (change === "personId")
      currentActor = { ...currentActor, personId: "person-2" };
    if (change === "approved")
      currentActor = { ...currentActor, approved: false };
    releaseList();
    await pending;

    assert.equal(replies.length, 1);
    if (change === "unchanged") {
      assert.equal(replies[0].status, 200);
      assert.match(replies[0].body, /private AI result/);
    } else {
      assert.equal(replies[0].status, 403, change);
      assert.doesNotMatch(replies[0].body, /private AI result|Private/);
    }
  }
});

test("queued proposal rejection cannot commit after tier or role downgrade", async () => {
  for (const change of ["tier", "role"] as const) {
    let viewerFull = true;
    const actor = { id: "researcher", approved: true, role: "admin" };
    let currentActor = { ...actor };
    let enterTransaction!: () => void;
    let releaseTransaction!: () => void;
    const transactionEntered = new Promise<void>((resolve) => {
      enterTransaction = resolve;
    });
    const transactionWait = new Promise<void>((resolve) => {
      releaseTransaction = resolve;
    });
    let markCalls = 0;
    let status = 0;
    let body = "";
    const handler = researchSuggestionsHttp({
      archive: {
        db: {
          kind: "postgres",
          archiveId: "archive-1",
          inTransaction: () => true,
          transaction: async (work: () => Promise<boolean>) => {
            enterTransaction();
            await transactionWait;
            return work();
          },
          prepare: (_sqlite: string, postgres: string) => ({
            get: async () => postgres.includes("FROM account_sessions")
              ? { user_id: actor.id, expires_at: Date.now() + 60_000 }
              : postgres.includes("FROM archive_memberships")
                ? {
                    role: currentActor.role,
                    approved: currentActor.approved,
                    person_id: null,
                    tree_access: "all",
                  }
                : { viewer_full: viewerFull, owner_full: true },
          }),
        },
      },
      auth: {
        local: false,
        currentUser: async () => currentActor,
        canEdit: async () => true,
        accountSession: async () => ({ accountId: actor.id, tokenHash: "session" }),
      },
      suggestions: {
        mark: async () => {
          markCalls++;
          return { id: "pending-ai-proposal", reason: "private AI result" };
        },
      },
    } as unknown as Parameters<typeof researchSuggestionsHttp>[0]);
    const request = { method: "POST", headers: {} } as IncomingMessage;
    const response = {
      writeHead(code: number) { status = code; },
      end(value: string) { body = value; },
    } as unknown as ServerResponse;
    const pending = handler(
      request,
      response,
      new URL("http://localhost/api/research/suggestions/pending-ai-proposal/reject"),
    );
    await transactionEntered;
    if (change === "tier") viewerFull = false;
    else currentActor = { ...currentActor, role: "researcher" };
    releaseTransaction();
    await pending;

    assert.equal(status, 403, change);
    assert.equal(markCalls, 0, change);
    assert.doesNotMatch(body, /private AI result/);
  }
});
