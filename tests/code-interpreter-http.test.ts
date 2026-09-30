import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash, randomBytes } from "node:crypto";
import { startServer } from "../src/server/index.ts";
import {
  aiSettingsStore,
  defaultAiRoleProfile,
} from "../src/server/ai-settings.ts";

for (const mode of ["global-disabled", "role-disabled", "enabled", "budget"])
  test(`agent integrates Code Interpreter and protects artifacts (${mode})`, async () => {
    const enabled = mode === "enabled" || mode === "budget";
    const dir = mkdtempSync(join(tmpdir(), "drevo-calculation-http-"));
    const env = {
      PUBLIC_ORIGIN: "http://localhost",
      YANDEX_AI_API_KEY: "test-calculation-key",
      YANDEX_AI_FOLDER_ID: "folder",
      YANDEX_AI_MODEL: "model",
    };
    const previous = Object.fromEntries(
      Object.keys(env).map((key) => [key, process.env[key]]),
    );
    Object.assign(process.env, env);
    let agentCalls = 0,
      calculations = 0;
    const app = await startServer(
      0,
      join(dir, "archive.sqlite"),
      true,
      undefined,
      async (url, init) => {
        if (init?.method === "DELETE") return Response.json({ deleted: true });
        if (String(url).endsWith("/conversations"))
          return Response.json({ id: "remote" });
        if (String(url).endsWith("/files"))
          return Response.json({ id: "file-input" });
        if (String(url).endsWith("/content"))
          return new Response("year,count\n1900,2");
        const body = JSON.parse(String(init?.body));
        if (body.tools?.[0]?.type === "code_interpreter") {
          calculations++;
          return Response.json({
            status: "completed",
            usage: { input_tokens: 17, output_tokens: 31 },
            output: [
              {
                type: "code_interpreter_call",
                status: "completed",
                container_id: "container",
              },
              {
                type: "message",
                content: [
                  {
                    type: "output_text",
                    text: "Расчёт выполнен.",
                    annotations: [
                      {
                        type: "container_file_citation",
                        container_id: "container",
                        file_id: "file-output",
                        filename: "table.csv",
                      },
                    ],
                  },
                ],
              },
            ],
          });
        }
        agentCalls++;
        assert.equal(
          body.tools.some(
            (tool: { name: string }) => tool.name === "run_code_interpreter",
          ),
          enabled && calculations < 2,
        );
        if (agentCalls <= (mode === "budget" ? 3 : 1))
          return Response.json({
            id: "first",
            status: "completed",
            output: [
              {
                type: "function_call",
                call_id: "calculate",
                name: "run_code_interpreter",
                arguments: JSON.stringify({
                  task: "Посчитай распределение",
                  fields: ["birth"],
                }),
              },
            ],
          });
        assert.doesNotMatch(
          JSON.stringify(body.input),
          /test-calculation-key|"type":"Buffer"/,
        );
        const result = JSON.parse(body.input[0].output);
        if (enabled && mode !== "budget")
          assert.match(result.files[0].url, /^\/api\/ai\/files\//);
        else assert.ok(result.error);
        return Response.json({
          id: "final",
          status: "completed",
          output_text: enabled
            ? "Расчёт готов, таблица приложена."
            : "Вычисления отключены.",
        });
      },
    );
    try {
      const settings = await aiSettingsStore(app.archive.db);
      const before = await settings.read();
      await settings.write(
        {
          ...before,
          codeInterpreterEnabled: mode !== "global-disabled",
          roleProfiles: {
            ...before.roleProfiles,
            admin: {
              ...defaultAiRoleProfile(before),
              codeInterpreterEnabled: mode !== "role-disabled",
            },
          },
        },
        {
          id: "local",
          name: "Администратор",
          role: "admin",
          createdAt: "",
          approved: true,
        },
      );
      const base = `http://127.0.0.1:${(app.server.address() as { port: number }).port}`;
      await app.archive.db
        .prepare(
          "INSERT OR IGNORE INTO users(id,name,role,approved) VALUES('owner','Владелец','admin',1)",
        )
        .run();
      const ownerToken = randomBytes(32).toString("hex");
      await app.archive.db
        .prepare(
          "INSERT INTO auth_sessions(token_hash,user_id,expires_at) VALUES(?,?,?)",
        )
        .run(
          createHash("sha256").update(ownerToken).digest("hex"),
          "owner",
          Date.now() + 60000,
        );
      const request: typeof fetch = (input, init) => {
        const headers = new Headers(init?.headers);
        if (!headers.has("Cookie"))
          headers.set("Cookie", `drevo_session=${ownerToken}`);
        headers.set("Origin", env.PUBLIC_ORIGIN);
        return fetch(input, { ...init, headers });
      };
      const response = await request(base + "/api/ai/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message: "Выполни расчёт в Python" }),
      });
      assert.equal(response.status, 200);
      const result = await response.json();
      assert.equal(calculations, mode === "budget" ? 2 : enabled ? 1 : 0);
      if (enabled) {
        const file = result.files[0];
        assert.equal(file.name, "table.csv");
        const download = await request(base + file.url);
        assert.equal(download.status, 200);
        assert.match(download.headers.get("content-type")!, /text\/csv/);
        assert.match(
          download.headers.get("content-disposition")!,
          /attachment/,
        );
        assert.equal(download.headers.get("x-content-type-options"), "nosniff");
        assert.equal(await download.text(), "year,count\n1900,2");
        await app.archive.db
          .prepare(
            "INSERT INTO users(id,name,role,approved) VALUES('other','Другой','reader',1)",
          )
          .run();
        const token = randomBytes(32).toString("hex");
        await app.archive.db
          .prepare(
            "INSERT INTO auth_sessions(token_hash,user_id,expires_at) VALUES(?,?,?)",
          )
          .run(
            createHash("sha256").update(token).digest("hex"),
            "other",
            Date.now() + 60000,
          );
        assert.equal(
          (
            await request(base + file.url, {
              headers: { Cookie: `drevo_session=${token}` },
            })
          ).status,
          404,
        );
        const chat = await request(
          base + `/api/ai/chats/${result.chatId}`,
        ).then((value) => value.json());
        assert.equal(chat.messages.at(-1).files[0].url, file.url);
        await request(base + `/api/ai/chats/${result.chatId}`, {
          method: "DELETE",
        });
        assert.equal((await request(base + file.url)).status, 404);
      } else assert.deepEqual(result.files, []);
    } finally {
      await app.close();
      for (const [key, value] of Object.entries(previous)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
      rmSync(dir, { recursive: true, force: true });
    }
  });
