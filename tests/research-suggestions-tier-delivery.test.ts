import test from "node:test";
import assert from "node:assert/strict";
import type { IncomingMessage, ServerResponse } from "node:http";
import { researchSuggestionsHttp } from "../src/server/research-suggestions-http.ts";

test("queued AI proposals are withheld when viewer or owner loses full access", async () => {
  for (const downgraded of ["viewer", "owner"] as const) {
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
    const actor = { id: "researcher", approved: true, role: "researcher" };
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
          prepare: () => ({
            get: async () => ({
              viewer_full: viewerFull,
              owner_full: ownerFull,
            }),
          }),
        },
        read: async () => ({ family: { people: [] } }),
      },
      auth: {
        local: false,
        currentUser: async () => actor,
        canEdit: async () => true,
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
    if (downgraded === "viewer") viewerFull = false;
    else ownerFull = false;
    releaseList();
    await pending;

    assert.equal(replies.length, 1);
    assert.equal(replies[0].status, 403);
    assert.doesNotMatch(replies[0].body, /private AI result|Private/);
  }
});
