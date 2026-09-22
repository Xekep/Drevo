import type { IncomingMessage, ServerResponse } from "node:http";
import { createMcpHandler, fromJsonSchema, McpServer } from "@modelcontextprotocol/server";
import type { openArchive } from "./database.ts";
import type { mcpTokenStore } from "./mcp-tokens.ts";
import {
  executeResearchTool,
  RESEARCH_TOOL_DEFINITIONS,
} from "../domain/research-tools.ts";

export function mcpHttp({
  archive,
  tokens,
}: {
  archive: ReturnType<typeof openArchive>;
  tokens: ReturnType<typeof mcpTokenStore>;
}) {
  return async (
    req: IncomingMessage,
    res: ServerResponse,
    url: URL,
  ): Promise<boolean> => {
    if (url.pathname !== "/mcp") return false;

    const grant = tokens.authenticate(req.headers.authorization);
    if (!grant) {
      res.writeHead(401, {
        "Content-Type": "application/json; charset=utf-8",
        "Cache-Control": "no-store",
        "WWW-Authenticate": 'Bearer realm="Drevo MCP"',
      });
      res.end(JSON.stringify({ error: "Недействительный MCP-токен" }));
      return true;
    }

    const family = archive.read().family;
    const handler = createMcpHandler(() => {
      const server = new McpServer({
        name: "drevo",
        version: "0.1.0",
      });
      for (const definition of RESEARCH_TOOL_DEFINITIONS) {
        if (!grant.scopes.includes(definition.scope)) continue;
        server.registerTool(
          definition.name,
          {
            description: definition.description,
            inputSchema: fromJsonSchema<Record<string, unknown>>(
              definition.inputSchema,
            ),
            annotations: {
              readOnlyHint: true,
              destructiveHint: false,
              idempotentHint: true,
              openWorldHint: false,
            },
          },
          async (args) => {
            try {
              const result = executeResearchTool(
                family,
                definition.name,
                args,
              ) as Record<string, unknown>;
              return {
                content: [{ type: "text", text: JSON.stringify(result) }],
                structuredContent: result,
              };
            } catch (error) {
              return {
                content: [
                  {
                    type: "text",
                    text:
                      error instanceof Error
                        ? error.message
                        : "Ошибка исследовательского инструмента",
                  },
                ],
                isError: true,
              };
            }
          },
        );
      }
      return server;
    });

    const headers = new Headers();
    for (const [name, value] of Object.entries(req.headers)) {
      if (value === undefined) continue;
      if (Array.isArray(value))
        for (const item of value) headers.append(name, item);
      else headers.set(name, value);
    }
    const chunks: Buffer[] = [];
    if (req.method !== "GET" && req.method !== "HEAD")
      for await (const chunk of req) chunks.push(Buffer.from(chunk));
    const request = new Request(
      new URL(req.url || "/mcp", `http://${req.headers.host || "localhost"}`),
      {
        method: req.method,
        headers,
        ...(chunks.length ? { body: Buffer.concat(chunks).toString("utf8") } : {}),
      },
    );
    const response = await handler.fetch(request);
    res.statusCode = response.status;
    response.headers.forEach((value, name) => res.setHeader(name, value));
    if (!response.body) res.end();
    else {
      const reader = response.body.getReader();
      while (true) {
        const chunk = await reader.read();
        if (chunk.done) break;
        res.write(Buffer.from(chunk.value));
      }
      res.end();
    }
    return true;
  };
}
