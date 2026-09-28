import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startServer } from "../src/server/index.ts";

const packageName = ["@modelcontextprotocol", "client"].join("/");
const { Client, StreamableHTTPClientTransport } = await import(packageName);

const dir = mkdtempSync(join(tmpdir(), "drevo-mcp-sdk-"));
const app = await startServer(0, join(dir, "drevo.sqlite"), true);
const base =
  "http://127.0.0.1:" +
  /** @type {{port:number}} */ (app.server.address()).port;

try {
  const current = await app.archive.read();
  await app.archive.write(
    {
      ...current.family,
      people: [
        ...current.family.people,
        {
          id: "official-sdk-person",
          surname: "Совместимость",
          name: "Анна",
          patronymic: "",
          sex: "f",
          birth: "1901",
          birthPlace: "Тест",
          parents: [],
          spouses: [],
          generation: 1,
          column: 0,
          sources: [],
        },
      ],
    },
    current.revision,
  );

  const issuedResponse = await fetch(base + "/api/mcp/tokens", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      name: "Official SDK compatibility",
      scopes: ["tree:read", "sources:read", "analysis:read"],
      rateLimitPerMinute: 100,
    }),
  });
  assert.equal(issuedResponse.status, 201);
  const issued = await issuedResponse.json();

  async function check(mode, expectedEra) {
    const client = new Client(
      { name: "drevo-official-sdk-smoke", version: "1.0.0" },
      { versionNegotiation: { mode } },
    );
    const transport = new StreamableHTTPClientTransport(
      new URL(base + "/mcp"),
      {
        requestInit: {
          headers: {
            Authorization: "Bearer " + issued.token,
          },
        },
      },
    );
    try {
      await client.connect(transport);
      assert.equal(client.getProtocolEra(), expectedEra);

      const listed = await client.listTools();
      assert.ok(
        listed.tools.some((tool) => tool.name === "search_people"),
        mode + " client did not receive search_people",
      );

      const result = await client.callTool({
        name: "search_people",
        arguments: { query: "Совместимость" },
      });
      assert.equal(result.isError, undefined);
      assert.ok(
        result.structuredContent &&
          Array.isArray(result.structuredContent.people),
      );
      assert.ok(
        result.structuredContent.people.some(
          (person) => person.id === "official-sdk-person",
        ),
        mode + " client did not receive the expected person",
      );
    } finally {
      await client.close();
    }
  }

  await check("auto", "modern");
  await check("legacy", "legacy");

  console.log(
    "Official MCP TypeScript client connected in modern and legacy modes.",
  );
} finally {
  await app.close();
  rmSync(dir, { recursive: true, force: true });
}
