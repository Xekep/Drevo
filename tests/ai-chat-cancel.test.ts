import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startServer } from "../src/server/index.ts";
import { aiChatStore } from "../src/server/ai-chats.ts";

test("a late provider answer cannot commit after another runner acquires the expired lease", { timeout: 10000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "drevo-late-answer-"));
  const values = { YANDEX_AI_API_KEY: "test-key", YANDEX_AI_FOLDER_ID: "folder", YANDEX_AI_MODEL: "model" };
  const previous = Object.fromEntries(Object.keys(values).map((key) => [key, process.env[key]]));
  Object.assign(process.env, values);
  let enter: () => void = () => {}, release: () => void = () => {};
  const entered = new Promise<void>((resolve) => { enter = resolve; });
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const app = await startServer(0, join(dir, "archive.sqlite"), true, undefined, async (url, init) => {
    if (init?.method === "DELETE") return Response.json({ deleted: true });
    if (String(url).endsWith("/conversations")) return Response.json({ id: "remote" });
    enter();
    await gate;
    return Response.json({ id: "late-response", status: "completed", output: [], output_text: "Поздний ответ" });
  });
  let pending: Promise<Response> | undefined;
  const chats = aiChatStore(app.archive.db);
  try {
    const chat = await chats.create("local", JSON.stringify(["admin", "all", ""]));
    const base = `http://127.0.0.1:${(app.server.address() as { port: number }).port}`;
    pending = fetch(`${base}/api/ai/chat`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chatId: chat.id, message: "Исследуй архив" }),
    });
    await Promise.race([entered, pending.then((response) => {
      throw new Error(`Turn ended before provider: ${response.status}`);
    })]);
    await app.archive.db.prepare("UPDATE ai_chats SET busy_until=? WHERE id=?").run(Date.now() - 1, chat.id);
    const replacement = (await chats.acquire(chat.id))!;
    assert.ok(replacement);
    // Release immediately so the final commit guard, not the timer, fences the old turn.
    release();
    const response = await pending;
    assert.equal(response.status, 502);
    assert.doesNotMatch(await response.text(), /Поздний ответ/);
    assert.deepEqual((await chats.messages(chat.id, "local"))!.map((message) => message.role), ["user"]);
    assert.equal(await chats.turnStatus(chat.id, replacement), "active",
      "cleanup of the old runner must not release the replacement lease");
    await chats.release(chat.id, replacement);
  } finally {
    release();
    await pending;
    await app.close();
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    rmSync(dir, { recursive: true, force: true });
  }
});

for (const streaming of [false, true]) {
  for (const phase of ["conversations", "responses"] as const) {
    for (const action of ["stop", "delete", "disconnect"] as const) {
      for (const remote of action === "disconnect" ? [false] : [false, true]) {
        test(
          `${remote ? "another backend " : ""}${action} controls a hidden ${streaming ? "SSE" : "HTTP"} turn during Yandex ${phase}`,
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
            const otherApp = remote
              ? await startServer(
                  0,
                  join(dir, "archive.sqlite"),
                  true,
                  undefined,
                  fake,
                )
              : undefined;
            const controlBase = otherApp
              ? `http://127.0.0.1:${(otherApp.server.address() as { port: number }).port}`
              : base;
            const send = (chatId?: string, signal?: AbortSignal) =>
              fetch(
                base +
                  (streaming && chatId
                    ? "/api/ai/chat/stream"
                    : "/api/ai/chat"),
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
              if (phase === "conversations") await chats.setRemote(id, null);
              waiting = true;
              pending = send(id, controller.signal)
                .then(async (response) => {
                  await response.text();
                  return response;
                })
                .catch(() => undefined);
              await entered;
              const detail = await fetch(`${base}/api/ai/chats/${id}`).then(
                (r) => r.json(),
              );
              assert.equal(
                detail.chat.busy,
                true,
                "history exposes server work after a reload",
              );
              const forbidden = await fetch(
                `${controlBase}/api/ai/chats/${id}/stop`,
                {
                  method: "POST",
                  headers: { Origin: "https://evil.example" },
                },
              );
              assert.equal(forbidden.status, 403);
              assert.equal(aborted, false);
              const other = await chats.create("another-user", "[]");
              assert.equal(
                (
                  await fetch(`${controlBase}/api/ai/chats/${other.id}/stop`, {
                    method: "POST",
                  })
                ).status,
                404,
              );
              if (action === "disconnect") controller.abort();
              else {
                const response = await fetch(
                  `${controlBase}/api/ai/chats/${id}${action === "stop" ? "/stop" : ""}`,
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
                assert.ok(await chats.isBusy(id));
                waiting = false;
                release();
              }
              for (
                let attempt = 0;
                attempt < 100 && (await chats.isBusy(id));
                attempt++
              )
                await new Promise((resolve) => setTimeout(resolve, 10));
              assert.equal(
                aborted,
                action !== "disconnect",
                "only explicit stop/delete aborts upstream setup or generation",
              );
              assert.ok(!(await chats.isBusy(id)));
              if (action === "delete") {
                assert.equal(await chats.read(id, "local"), null);
                assert.equal(
                  (
                    await app.archive.db
                      .prepare(
                        "SELECT count(*) AS n FROM ai_chat_messages WHERE chat_id=?",
                      )
                      .get(id)
                  )?.n,
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
              await otherApp?.close();
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
}
