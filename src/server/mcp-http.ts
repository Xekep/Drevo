import type { IncomingMessage, ServerResponse } from "node:http";
import type { openArchive } from "./database.ts";
import type { mcpTokenStore } from "./mcp-tokens.ts";
import { McpRateLimitError, type mcpUsageStore } from "./mcp-usage.ts";
import {
  executeResearchTool,
  RESEARCH_TOOL_DEFINITIONS,
} from "../domain/research-tools.ts";
import { projectFamilyForUser } from "../domain/tree-access.ts";
import { isSameOriginRequest } from "./same-origin.ts";
import { accountAiAccess } from "./account-ai-access.ts";

type JsonRpcId = string | number | null;
type JsonRpcRequest = {
  jsonrpc?: unknown;
  id?: JsonRpcId;
  method?: unknown;
  params?: unknown;
};

const MCP_PROTOCOL_VERSIONS = [
  "2026-07-28",
  "2025-11-25",
  "2025-06-18",
  "2025-03-26",
] as const;
const MCP_SERVER_INFO = { name: "drevo", version: "0.1.0" };
const MCP_INSTRUCTIONS =
  "Read-only genealogy research tools. Do not treat missing records as proof that an event or relationship did not exist.";

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

function requestMetaProtocolVersion(request: JsonRpcRequest) {
  if (!request.params || typeof request.params !== "object") return "";
  const meta = (request.params as Record<string, unknown>)._meta;
  if (!meta || typeof meta !== "object") return "";
  const version = (meta as Record<string, unknown>)[
    "io.modelcontextprotocol/protocolVersion"
  ];
  return typeof version === "string" ? version : "";
}

function requestProtocolVersion(request: JsonRpcRequest, req: IncomingMessage) {
  const header = req.headers["mcp-protocol-version"];
  return typeof header === "string"
    ? header
    : requestMetaProtocolVersion(request);
}

function modernResult(value: Record<string, unknown>, cacheable = false) {
  const meta =
    value._meta && typeof value._meta === "object"
      ? (value._meta as Record<string, unknown>)
      : {};
  return {
    resultType: "complete",
    ...value,
    ...(cacheable ? { ttlMs: 0, cacheScope: "private" } : {}),
    _meta: {
      ...meta,
      "io.modelcontextprotocol/serverInfo": MCP_SERVER_INFO,
    },
  };
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
  usage,
  publicOrigin,
}: {
  archive: Awaited<ReturnType<typeof openArchive>>;
  tokens: ReturnType<typeof mcpTokenStore>;
  usage: ReturnType<typeof mcpUsageStore>;
  publicOrigin?: string;
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

    if (!isSameOriginRequest(req, publicOrigin))
      return json(res, 403, {
        error: "Invalid origin",
      });

    const grant = await tokens.authenticate(req.headers.authorization);
    if (!grant) {
      res.setHeader("WWW-Authenticate", 'Bearer realm="Drevo MCP"');
      return json(res, 401, { error: "Недействительный MCP-токен" });
    }
    const hasAiAccess = async () =>
      (await accountAiAccess(archive.db, grant.createdBy, !publicOrigin)) &&
      (!grant.boundUser ||
        (await accountAiAccess(archive.db, grant.boundUser.id, !publicOrigin)));
    if (!(await hasAiAccess()))
      return json(res, 403, { error: "ИИ-функции недоступны этому аккаунту" });
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
    if (!(await hasAiAccess()))
      return json(res, 403, { error: "ИИ-функции недоступны этому аккаунту" });

    const protocolVersion = requestProtocolVersion(request, req),
      metaVersion = requestMetaProtocolVersion(request),
      modern = protocolVersion === "2026-07-28",
      headerVersion = req.headers["mcp-protocol-version"];

    if (
      typeof headerVersion === "string" &&
      metaVersion &&
      headerVersion !== metaVersion
    )
      return json(
        res,
        400,
        error(id, -32020, "MCP protocol version header does not match _meta"),
      );

    if (
      protocolVersion &&
      !MCP_PROTOCOL_VERSIONS.includes(
        protocolVersion as (typeof MCP_PROTOCOL_VERSIONS)[number],
      )
    )
      return json(
        res,
        400,
        error(id, -32022, "Unsupported MCP protocol version", {
          supported: MCP_PROTOCOL_VERSIONS,
          requested: protocolVersion,
        }),
      );

    if (request.method.startsWith("notifications/")) {
      res.writeHead(202, { "Cache-Control": "no-store" });
      res.end();
      return true;
    }

    const auditParams =
        request.params && typeof request.params === "object"
          ? (request.params as Record<string, unknown>)
          : {},
      toolName =
        request.method === "tools/call" && typeof auditParams.name === "string"
          ? auditParams.name.slice(0, 200)
          : undefined;
    try {
      await usage.check(grant.id, grant.rateLimitPerMinute);
    } catch (reason) {
      if (reason instanceof McpRateLimitError) {
        if (reason.retryAfterSeconds)
          res.setHeader("Retry-After", String(reason.retryAfterSeconds));
        return json(
          res,
          429,
          error(id, -32000, reason.message, {
            retryAfterSeconds: reason.retryAfterSeconds,
          }),
        );
      }
      throw reason;
    }
    const auditRun = await usage.begin(grant.id, request.method, toolName);
    let auditError = false;
    res.once("finish", async () => {
      await usage.finish(
        auditRun.id,
        auditRun.started,
        auditError || res.statusCode >= 400 ? "error" : "ok",
      );
    });

    if (request.method === "server/discover")
      return json(
        res,
        200,
        result(
          id,
          modernResult(
            {
              supportedVersions: ["2026-07-28"],
              capabilities: { tools: { listChanged: false } },
              instructions: MCP_INSTRUCTIONS,
            },
            true,
          ),
        ),
      );

    if (request.method === "initialize") {
      const params =
          request.params && typeof request.params === "object"
            ? (request.params as Record<string, unknown>)
            : {},
        requested =
          typeof params.protocolVersion === "string"
            ? params.protocolVersion
            : "2025-11-25",
        protocolVersion = MCP_PROTOCOL_VERSIONS.includes(
          requested as (typeof MCP_PROTOCOL_VERSIONS)[number],
        )
          ? requested
          : "2025-11-25";
      if (protocolVersion === "2026-07-28")
        return json(
          res,
          400,
          error(id, -32602, "Use server/discover for MCP 2026-07-28"),
        );
      return json(
        res,
        200,
        result(id, {
          protocolVersion,
          capabilities: { tools: { listChanged: false } },
          serverInfo: MCP_SERVER_INFO,
          instructions: MCP_INSTRUCTIONS,
        }),
      );
    }

    if (request.method === "ping") {
      if (modern) {
        auditError = true;
        return json(res, 404, error(id, -32601, "Method not found"));
      }
      return json(res, 200, result(id, {}));
    }

    if (request.method === "tools/list") {
      const available = RESEARCH_TOOL_DEFINITIONS.filter((definition) =>
        grant.scopes.includes(definition.scope),
      ).map((definition) => ({
        name: definition.name,
        description: definition.description,
        inputSchema: definition.inputSchema,
        annotations: {
          readOnlyHint: true,
          destructiveHint: false,
          idempotentHint: true,
          openWorldHint: false,
        },
      }));
      return json(
        res,
        200,
        result(
          id,
          modern
            ? modernResult({ tools: available }, true)
            : { tools: available },
        ),
      );
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
      if (!definition || !grant.scopes.includes(definition.scope)) {
        auditError = true;
        return json(
          res,
          200,
          result(
            id,
            modern
              ? modernResult({
                  content: [
                    {
                      type: "text",
                      text: "Инструмент не найден или не разрешён этим токеном",
                    },
                  ],
                  isError: true,
                })
              : {
                  content: [
                    {
                      type: "text",
                      text: "Инструмент не найден или не разрешён этим токеном",
                    },
                  ],
                  isError: true,
                },
          ),
        );
      }
      try {
        const sourceFamily = (await archive.read()).family;
        if (!(await hasAiAccess()))
          return json(res, 403, { error: "ИИ-функции недоступны этому аккаунту" });
        const family = grant.boundUser
            ? projectFamilyForUser(sourceFamily, grant.boundUser)
            : sourceFamily,
          value = executeResearchTool(
            family,
            definition.name,
            params.arguments,
          );
        return json(
          res,
          200,
          result(
            id,
            modern
              ? modernResult({
                  content: [{ type: "text", text: JSON.stringify(value) }],
                  structuredContent: value,
                })
              : {
                  content: [{ type: "text", text: JSON.stringify(value) }],
                  structuredContent: value,
                },
          ),
        );
      } catch (reason) {
        auditError = true;
        return json(
          res,
          200,
          result(
            id,
            modern
              ? modernResult({
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
                })
              : {
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
                },
          ),
        );
      }
    }

    auditError = true;
    return json(res, modern ? 404 : 200, error(id, -32601, "Method not found"));
  };
}
