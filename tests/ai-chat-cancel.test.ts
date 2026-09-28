import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startServer } from "../src/server/index.ts";
import { aiChatStore } from "../src/server/ai-chats.ts";

for (const streaming of [false, true]) {
  for (const phase of ["conversations", "responses"] as const) {
    for (const action of ["stop", "delete", "disconnect"] as const) {
      test(
        `${action} controls a hidden ${streaming ? "SSE" : "HTTP"} turn during Yandex ${phase}`,
        { timeout: 10000 },
        async () => {
          const dir = mkdtempSync(join(tmpdir(), "drevo-cancel-"));
          const env = {
            YANDEX_AI_API_KEY: "test-key",
            YANDEX_AI_FOLDER_ID: "folder",
            YANDEX_AI_MODEL: "model",
          };
          const previous = Object.fromEntries(
            Object.keys(env).map((key) => [key, process.env[key]]),
          );
          Object.assign(process.env, env);
          let waiting = false,
            aborted = false;
          let enter: () => void = () => {},
            release: () => void = () => {};
          const entered = new Promise<void>((resolve) => {
            enter = resolve;
          });
          const fake: typeof fetch = async (url, init) => {
            if (init?.method === "DELETE")
              return Response.json({ deleted: true });
            if (waiting && String(url).endsWith(`/${phase}`)) {
              await new Promise<void>((resolve, reject) => {
                release = resolve;
                init?.signal?.addEventListener(
                  "abort",
                  () => {
                    aborted = true;
                    reject(init.signal!.reason);
                  },
                  { once: true },
                );
                enter();
              });
            }
            if (String(url).endsWith("/conversations"))
              return Response.json({ id: "remote" });
            const response = {
              id: "response",
              status: "completed",
              output: [],
              output_text: "Ответ готов",
            };
            return JSON.parse(String(init?.body)).stream
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
          const base = `http://127.0.0.1:${(app.server.address() as { port: number }).port}`;
          const send = (chatId?: string, signal?: AbortSignal) =>
            fetch(
              base +
                (streaming && chatId ? "/api/ai/chat/stream" : "/api/ai/chat"),
              {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                  message: "Продолжи исследование",
                  chatId,
                }),
                signal,
              },
            );
          let pending: Promise<Response | undefined> | undefined;
          const controller = new AbortController();
          try {
            const initial = await send().then((r) => r.json());
            const id = initial.chatId as string;
            assert.ok(id);
            const chats = aiChatStore(app.archive.db);
            if (phase === "conversations") chats.setRemote(id, null);
            waiting = true;
            pending = send(id, controller.signal)
              .then(async (response) => {
                await response.text();
                return response;
              })
              .catch(() => undefined);
            await entered;
            const detail = await fetch(`${base}/api/ai/chats/${id}`).then((r) =>
              r.json(),
            );
            assert.equal(
              detail.chat.busy,
              true,
              "history exposes server work after a reload",
            );
            const forbidden = await fetch(`${base}/api/ai/chats/${id}/stop`, {
              method: "POST",
              headers: { Origin: "https://evil.example" },
            });
            assert.equal(forbidden.status, 403);
            assert.equal(aborted, false);
            const other = chats.create("another-user", "[]");
            assert.equal(
              (
                await fetch(`${base}/api/ai/chats/${other.id}/stop`, {
                  method: "POST",
                })
              ).status,
              404,
            );
            if (action === "disconnect") controller.abort();
            else {
              const response = await fetch(
                `${base}/api/ai/chats/${id}${action === "stop" ? "/stop" : ""}`,
                { method: action === "stop" ? "POST" : "DELETE" },
              );
              assert.equal(response.status, 200);
              const body = await response.json();
              if (action === "stop") assert.equal(body.busy, false);
              else assert.equal(body.deleted, true);
            }
            await pending;
            if (action === "disconnect") {
              await new Promise((resolve) => setTimeout(resolve, 25));
              assert.equal(aborted, false);
              assert.ok(chats.isBusy(id));
              waiting = false;
              release();
            }
            for (let attempt = 0; attempt < 100 && chats.isBusy(id); attempt++)
              await new Promise((resolve) => setTimeout(resolve, 10));
            assert.equal(
              aborted,
              action !== "disconnect",
              "only explicit stop/delete aborts upstream setup or generation",
            );
            assert.ok(!chats.isBusy(id));
            if (action === "delete") {
              assert.equal(chats.read(id, "local"), null);
              assert.equal(
                app.archive.db
                  .prepare(
                    "SELECT count(*) AS n FROM ai_chat_messages WHERE chat_id=?",
                  )
                  .get(id)?.n,
                0,
              );
            } else {
              if (action === "disconnect") {
                const recovered = await fetch(
                  `${base}/api/ai/chats/${id}`,
                ).then((response) => response.json());
                assert.equal(recovered.chat.busy, false);
                assert.equal(recovered.messages.at(-1).role, "assistant");
                assert.equal(recovered.messages.length, 4);
              }
              const deleted = await fetch(`${base}/api/ai/chats/${id}`, {
                method: "DELETE",
              });
              assert.equal(deleted.status, 200);
            }
          } finally {
            release();
            controller.abort();
            await pending;
            await app.close();
            for (const [key, value] of Object.entries(previous)) {
              if (value === undefined) delete process.env[key];
              else process.env[key] = value;
            }
            rmSync(dir, { recursive: true, force: true });
          }
        },
      );
    }
  }
}
