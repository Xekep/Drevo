import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startServer } from "../src/server/index.ts";
import {
  newSessionToken,
  sessionTokenHash,
} from "../src/server/session-token.ts";
import {
  aiSettingsStore,
  defaultAiRoleProfile,
} from "../src/server/ai-settings.ts";
import type { Role } from "../src/domain/access.ts";

for (const streaming of [false, true])
  test(`AI profiles enforce session role and deny forged tool calls (${streaming ? "SSE" : "HTTP"})`, async () => {
    const dir = mkdtempSync(join(tmpdir(), "drevo-ai-roles-"));
    const env = {
      PUBLIC_ORIGIN: "http://localhost",
      YANDEX_AI_API_KEY: "role-profile-secret",
      YANDEX_AI_FOLDER_ID: "folder",
      YANDEX_AI_MODEL: "base",
    };
    const previous = Object.fromEntries(
      Object.keys(env).map((key) => [key, process.env[key]]),
    );
    Object.assign(process.env, env);
    const requests: Array<Record<string, unknown>> = [];
    let forbiddenTools = false;
    let deniedResults: Array<{ error: string }> = [];
    const fake: typeof fetch = async (url, init) => {
      if (String(url).endsWith("/conversations"))
        return Response.json({ id: "conv-test" });
      if (String(url).endsWith("/models"))
        return Response.json({
          data: [{ id: "gpt://folder/base", owned_by: "Yandex" }],
        });
      const body = JSON.parse(String(init?.body));
      requests.push(body);
      if (
        body.tools?.some((tool: { type: string }) => tool.type === "web_search")
      )
        throw new Error("Forbidden backend search executed");
      const toolOutput =
        body.input?.filter?.(
          (item: { type: string }) => item.type === "function_call_output",
        ) || [];
      if (toolOutput.length)
        deniedResults = toolOutput.map((item: { output: string }) =>
          JSON.parse(item.output),
        );
      const output =
        forbiddenTools && !toolOutput.length
          ? [
              [
                "analyze_photo",
                { photoId: "nonexistent", question: "describe" },
              ],
              ["create_pdf", { title: "forged", content: "forged" }],
              ["propose_person_create", { name: "forged" }],
              ["web_search", { query: "genealogy", scope: "global" }],
            ].map(([name, args], index) => ({
              type: "function_call",
              call_id: `call-${index}`,
              name,
              arguments: JSON.stringify(args),
            }))
          : [
              {
                type: "message",
                content: [
                  {
                    type: "output_text",
                    text: "Функции проверены. Ответ по доступным данным.",
                  },
                ],
              },
            ];
      const response = {
        id: "response-test",
        status: "completed",
        output,
        usage: { input_tokens: 10, output_tokens: 5 },
      };
      return body.stream
        ? new Response(
            `data: ${JSON.stringify({ type: "response.completed", response })}\n\n`,
            { headers: { "Content-Type": "text/event-stream" } },
          )
        : Response.json(response);
    };
    const app = await startServer(
      0,
      join(dir, "archive.sqlite"),
      true,
      undefined,
      fake,
    );
    try {
      const base = `http://127.0.0.1:${(app.server.address() as { port: number }).port}`;
      const cookies = {} as Record<Role, string>;
      for (const role of [
        "admin",
        "relative",
        "researcher",
        "reader",
      ] as const) {
        await app.archive.db
          .prepare("INSERT INTO users(id,name,role,approved) VALUES(?,?,?,1)")
          .run(role, role, role);
        const token = newSessionToken();
        await app.archive.db
          .prepare(
            "INSERT INTO auth_sessions(token_hash,user_id,expires_at) VALUES(?,?,?)",
          )
          .run(sessionTokenHash(token), role, Date.now() + 600000);
        cookies[role] = `drevo_session=${token}`;
      }
      const headers = (role: Role) => ({
        Cookie: cookies[role],
        Origin: "http://localhost",
        "Content-Type": "application/json",
      });
      const settings = await aiSettingsStore(app.archive.db);
      const stored = await settings.read();
      const profile = {
        ...defaultAiRoleProfile(stored),
        model: "researcher-model",
        webSearchEnabled: true,
        globalSearchEnabled: false,
        photoAnalysisEnabled: false,
        pdfEnabled: false,
        proposalsEnabled: false,
        requestsPerMinute: 0,
        dailyRequests: 50,
        dailyTokens: 50000,
      };
      const common = {
        ...stored,
        model: "base",
        folderId: "folder",
        requestsPerMinute: 0,
        dailyRequests: 100,
        dailyTokens: 100000,
        roleProfiles: {
          ...stored.roleProfiles,
          researcher: profile,
          relative: { ...profile, enabled: false },
          reader: { ...profile, model: "reader-model", proposalsEnabled: true },
        },
      };
      const saved = await fetch(base + "/api/admin/ai", {
        method: "PUT",
        headers: headers("admin"),
        body: JSON.stringify(common),
      });
      assert.equal(saved.status, 200);
      assert.ok(!(await saved.text()).includes(env.YANDEX_AI_API_KEY));
      assert.equal(
        (
          await fetch(base + "/api/admin/ai", {
            method: "PUT",
            headers: headers("researcher"),
            body: JSON.stringify(common),
          })
        ).status,
        403,
      );
      assert.equal(
        (
          await fetch(base + "/api/users/admin", {
            method: "PATCH",
            headers: headers("researcher"),
            body: JSON.stringify({ role: "researcher" }),
          })
        ).status,
        403,
      );
      for (const role of ["relative", "researcher", "reader"] as const) {
        const status = await fetch(base + "/api/ai/status", {
          headers: headers(role),
        }).then((r) => r.json());
        assert.equal(status.enabled, role !== "relative");
        assert.equal(status.canPropose, false);
        assert.ok(!JSON.stringify(status).includes(env.YANDEX_AI_API_KEY));
      }
      const chat = (role: Role, extra = {}) =>
        fetch(base + (streaming ? "/api/ai/chat/stream" : "/api/ai/chat"), {
          method: "POST",
          headers: headers(role),
          body: JSON.stringify({
            message: "Проанализируй фото и подготовь PDF с историей",
            role: "admin",
            model: "forged",
            capabilities: { pdf: true },
            ...extra,
          }),
        });
      const before = requests.length;
      assert.equal((await chat("relative")).status, 503);
      assert.equal(requests.length, before);
      forbiddenTools = true;
      const answer = await chat("researcher");
      assert.equal(answer.status, 200);
      const text = await answer.text();
      assert.ok(!text.includes(env.YANDEX_AI_API_KEY));
      assert.equal(requests.at(-1)?.model, "gpt://folder/researcher-model");
      const tools = requests.at(-1)?.tools as Array<{
        name: string;
        parameters: { properties: { scope?: { enum: string[] } } };
      }>;
      assert.ok(
        !tools.some((tool) =>
          ["analyze_photo", "create_pdf", "propose_person_create"].includes(
            tool.name,
          ),
        ),
      );
      assert.deepEqual(
        tools.find((tool) => tool.name === "web_search")?.parameters.properties
          .scope?.enum,
        ["trusted"],
      );
      assert.equal(deniedResults.length, 4);
      assert.ok(
        deniedResults.every((result) => typeof result.error === "string"),
      );
      assert.match(deniedResults[3].error, /Глобальный поиск отключён/);
      assert.equal(
        (
          await app.archive.db
            .prepare("SELECT count(*) AS n FROM research_suggestions")
            .get()
        )?.n,
        0,
      );
      await (await chat("reader", { message: "Расскажи об архиве" })).text();
      assert.equal(requests.at(-1)?.model, "gpt://folder/reader-model");
      assert.ok(
        !(requests.at(-1)?.tools as Array<{ name: string }>).some((tool) =>
          tool.name.startsWith("propose_"),
        ),
      );
      assert.ok(
        deniedResults.every((result) => typeof result.error === "string"),
      );
      forbiddenTools = false;
      const checked = await fetch(base + "/api/admin/ai/test?role=researcher", {
        method: "POST",
        headers: headers("admin"),
      });
      assert.equal(checked.status, 200);
      assert.equal((await checked.json()).model, "researcher-model");
      assert.equal(
        (
          await fetch(base + "/api/admin/ai/test?role=unknown", {
            method: "POST",
            headers: headers("admin"),
          })
        ).status,
        400,
      );
      // A saved conversation must use a changed profile on its very next turn.
      const chats = await fetch(base + "/api/ai/chats", {
        headers: headers("researcher"),
      }).then((r) => r.json());
      await settings.write(
        {
          ...common,
          roleProfiles: {
            ...common.roleProfiles,
            researcher: {
              ...profile,
              model: "new-researcher-model",
              webSearchEnabled: false,
            },
          },
        },
        { id: "admin", name: "Admin", role: "admin", createdAt: "" },
      );
      await (
        await chat("researcher", {
          chatId: chats.chats[0].id,
          message: "Продолжи рассказ",
        })
      ).text();
      assert.equal(requests.at(-1)?.model, "gpt://folder/new-researcher-model");
      assert.ok(
        !(requests.at(-1)?.tools as Array<{ name: string }>).some(
          (tool) => tool.name === "web_search",
        ),
      );
    } finally {
      await app.close();
      for (const [key, value] of Object.entries(previous)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
      rmSync(dir, { recursive: true, force: true });
    }
  });
