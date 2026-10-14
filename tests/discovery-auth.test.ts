import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { discoveryPeopleHttp } from "../src/server/discovery-people-http.ts";

test("discovery rejects anonymous hosted requests before catalog and rate-limit queries", async () => {
  for (const kind of ["postgres", "sqlite"] as const) {
    for (const local of [false, true]) {
      let databaseReads = 0;
      const noDatabaseRead = () => {
        databaseReads++;
        throw new Error("Denied discovery must not query the catalog");
      };
      const db = {
        kind,
        prepare: noDatabaseRead,
        postgresTransaction: noDatabaseRead,
      } as unknown as Parameters<typeof discoveryPeopleHttp>[0];
      const auth = {
        local,
        accountId: async () => null,
      } as unknown as Parameters<typeof discoveryPeopleHttp>[1];
      const handler = discoveryPeopleHttp(db, auth);
      const server = createServer((req, res) => {
        void handler(req, res, new URL(req.url || "/", "http://localhost"))
          .catch(() => { res.writeHead(500); res.end(); });
      });
      await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
      const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
      try {
        for (const path of ["/api/discovery/people?q=Иванов", "/api/discovery/people/tree-a/private-person"]) {
          const response = await fetch(base + path);
          // This retained bridge is limited to trusted local SQLite diagnostics.
          assert.equal(response.status, local && kind === "sqlite" ? 501 : 401);
          assert.match(response.headers.get("cache-control") || "", /no-store/);
          const body = await response.json();
          assert.equal(typeof body.error, "string");
          for (const field of ["results", "person", "linkedCards", "nextCursor"])
            assert.equal(field in body, false);
        }
        assert.equal(databaseReads, 0);
      } finally {
        server.closeAllConnections();
        await new Promise<void>(resolve => server.close(() => resolve()));
      }
    }
  }
});
