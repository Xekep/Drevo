import type { IncomingMessage, ServerResponse } from "node:http";
import type { openArchive } from "./database.ts";
import type { mcpTokenStore } from "./mcp-tokens.ts";
import {
  executeResearchTool,
  RESEARCH_TOOL_DEFINITIONS,
} from "../domain/research-tools.ts";

type JsonRpcId = string | number | null;
type JsonRpcRequest = {
  jsonrpc?: unknown;
  id?: JsonRpcId;
  method?: unknown;
  params?: unknown;
};

async function readJson(req: IncomingMessage) {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 1024 * 1024) throw new RangeError("Request too large");
    chunks.push(Buffer.from(chunk));
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

function result(id: JsonRpcId, value: unknown) {
  return { jsonrpc: "2.0", id, result: value };
}

function error(id: JsonRpcId, code: number, message: string, data?: unknown) {
  return {
    jsonrpc: "2.0",
    id,
    error: { code, message, ...(data === undefined ? {} : { data }) },
  };
}

export function mcpHttp({
  archive,
  tokens,
}: {
  archive: ReturnType<typeof openArchive>;
  tokens: ReturnType<typeof mcpTokenStore>;
}) {
  const json = (res: ServerResponse, status: number, value: unknown) => {
    res.writeHead(status, {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
    });
    res.end(JSON.stringify(value));
    return true;
  };

  return async (
    req: IncomingMessage,
    res: ServerResponse,
    url: URL,
  ): Promise<boolean> => {
    if (url.pathname !== "/mcp") return false;

    const grant = tokens.authenticate(req.headers.authorization);
    if (!grant) {
      res.setHeader("WWW-Authenticate", 'Bearer realm="Drevo MCP"');
      return json(res, 401, { error: "Недействительный MCP-токен" });
    }
    if (req.method !== "POST") {
      res.setHeader("Allow", "POST");
      return json(res, 405, { error: "MCP endpoint accepts POST only" });
    }
    if (!req.headers["content-type"]?.startsWith("application/json"))
      return json(res, 415, { error: "JSON required" });

    let request: JsonRpcRequest;
    try {
      request = (await readJson(req)) as JsonRpcRequest;
    } catch (reason) {
      if (reason instanceof RangeError)
        return json(res, 413, { error: reason.message });
      return json(res, 400, error(null, -32700, "Parse error"));
    }

    const id = request.id ?? null;
    if (request.jsonrpc !== "2.0" || typeof request.method !== "string")
      return json(res, 400, error(id, -32600, "Invalid Request"));

    if (request.method.startsWith("notifications/")) {
      res.writeHead(202, { "Cache-Control": "no-store" });
      res.end();
      return true;
    }

    if (request.method === "initialize") {
      const params =
          request.params && typeof request.params === "object"
            ? (request.params as Record<string, unknown>)
            : {},
        requested =
          typeof params.protocolVersion === "string"
            ? params.protocolVersion
            : "2026-07-28";
      return json(
        res,
        200,
        result(id, {
          protocolVersion: requested,
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: "drevo", version: "0.1.0" },
          instructions:
            "Read-only genealogy research tools. Do not treat missing records as proof that an event or relationship did not exist.",
        }),
      );
    }

    if (request.method === "ping") return json(res, 200, result(id, {}));

    if (request.method === "tools/list") {
      const available = RESEARCH_TOOL_DEFINITIONS.filter((definition) =>
        grant.scopes.includes(definition.scope),
      ).map(({ scope: _scope, ...definition }) => definition);
      return json(res, 200, result(id, { tools: available }));
    }

    if (request.method === "tools/call") {
      const params =
          request.params && typeof request.params === "object"
            ? (request.params as Record<string, unknown>)
            : {},
        name = typeof params.name === "string" ? params.name : "",
        definition = RESEARCH_TOOL_DEFINITIONS.find(
          (item) => item.name === name,
        );
      if (!definition || !grant.scopes.includes(definition.scope))
        return json(
          res,
          200,
          result(id, {
            content: [
              {
                type: "text",
                text: "Инструмент не найден или не разрешён этим токеном",
              },
            ],
            isError: true,
          }),
        );
      try {
        const value = executeResearchTool(
          archive.read().family,
          definition.name,
          params.arguments,
        );
        return json(
          res,
          200,
          result(id, {
            content: [{ type: "text", text: JSON.stringify(value) }],
            structuredContent: value,
          }),
        );
      } catch (reason) {
        return json(
          res,
          200,
          result(id, {
            content: [
              {
                type: "text",
                text:
                  reason instanceof Error
                    ? reason.message
                    : "Ошибка исследовательского инструмента",
              },
            ],
            isError: true,
          }),
        );
      }
    }

    return json(res, 200, error(id, -32601, "Method not found"));
  };
}
