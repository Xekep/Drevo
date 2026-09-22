import type { IncomingMessage, ServerResponse } from "node:http";
import { createMcpHandler, fromJsonSchema, McpServer } from "@modelcontextprotocol/server";
import { toNodeHandler } from "@modelcontextprotocol/node";
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

    await toNodeHandler(handler)(req, res);
    return true;
  };
}
