import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash, randomBytes } from "node:crypto";
import sharp from "sharp";
import { aiAttachmentStore, validateAttachments } from "../src/server/ai-attachments.ts";
import {
  attachmentSelectionError,
  AI_ATTACHMENT_BYTES,
} from "../src/shared/research-attachments.ts";
import { startServer } from "../src/server/index.ts";
import { aiChatStore, AiChatLimitError } from "../src/server/ai-chats.ts";
import { researchAttachmentContext, selectChatAttachments } from "../src/server/ai-attachment-context.ts";
import {
  aiSettingsStore,
  defaultAiRoleProfile,
} from "../src/server/ai-settings.ts";

const capabilities = { photoAnalysis: true, codeInterpreter: true };
const input = (name: string, content: string | Buffer) => ({
  name,
  data: Buffer.from(content).toString("base64"),
});

test("image attachments reject a mismatched signature before raster decoding", async () => {
  const png = await sharp({ create: { width: 2, height: 2, channels: 3, background: "white" } }).png().toBuffer();
  await assert.rejects(validateAttachments([input("wrong.jpg", png)], capabilities), RangeError);
  await assert.rejects(validateAttachments([input("vector.png", '<svg xmlns="http://www.w3.org/2000/svg" width="2" height="2"></svg>')], capabilities), RangeError);
});

test("attachment orphan pruning ignores a missing root but reports filesystem errors", async () => {
  const directory = mkdtempSync(join(tmpdir(), "drevo-attachment-prune-"));
  const chats = {} as ReturnType<typeof aiChatStore>;
  try {
    const uploads = join(directory, "uploads");
    await aiAttachmentStore(uploads, chats).prune();
    mkdirSync(uploads);
    writeFileSync(join(uploads, "ai-chat-files"), "not a directory");
    await assert.rejects(aiAttachmentStore(uploads, chats).prune(),
      (error: unknown) => (error as NodeJS.ErrnoException).code === "ENOTDIR");
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("attachments validate bytes, extensions, UTF-8, roles and limits on the server", async () => {
  for (const value of [
    null,
    {},
    [input("bad.exe", "binary")],
    [input("bad.pdf", "not pdf")],
    [input("bad.png", "not image")],
    [input("bad.txt", Buffer.from([0xff]))],
    [input("bad.txt", "a\0b")],
    [{ name: "a.txt", data: "???" }],
    Array.from({ length: 4 }, () => input("a.txt", "a")),
  ])
    await assert.rejects(validateAttachments(value, capabilities), RangeError);
  assert.match(
    attachmentSelectionError([
      { name: "a.txt", size: AI_ATTACHMENT_BYTES + 1 },
    ]),
    /5 МБ/,
  );
  await assert.rejects(
    validateAttachments(
      [input("a.txt", Buffer.alloc(AI_ATTACHMENT_BYTES + 1, 65))],
      capabilities,
    ),
    RangeError,
  );
  await assert.rejects(
    validateAttachments(
      Array.from({ length: 3 }, () =>
        input("a.txt", Buffer.alloc(AI_ATTACHMENT_BYTES, 65)),
      ),
      capabilities,
    ),
    /10 МБ/,
  );
  await assert.rejects(
    validateAttachments([input("a.xlsx", "PK\x03\x04")], {
      ...capabilities,
      codeInterpreter: false,
    }),
    /Code Interpreter/,
  );
  const png = await sharp({
    create: { width: 2, height: 2, channels: 3, background: "white" },
  })
    .png()
    .toBuffer();
  await assert.rejects(
    validateAttachments([input("a.png", png)], {
      ...capabilities,
      photoAnalysis: false,
    }),
    /отключён/,
  );
  const [file] = await validateAttachments(
    [input("../справка.txt", "Текст")],
    capabilities,
  );
  assert.equal(file.name, ".._справка.txt");
  assert.equal(file.type, "text/plain");
});

test("chat attachments reach AI, survive restart, enforce ownership/scope and delete with chat", async () => {
  const directory = mkdtempSync(join(tmpdir(), "drevo-ai-attachments-"));
  const env = {
    PUBLIC_ORIGIN: "http://localhost",
    YANDEX_AI_API_KEY: "attachment-test-secret",
    YANDEX_AI_FOLDER_ID: "folder",
    YANDEX_AI_MODEL: "model",
  };
  const old = Object.fromEntries(
    Object.keys(env).map((key) => [key, process.env[key]]),
  );
  Object.assign(process.env, env);
  const requests: Record<string, unknown>[] = [];
  let libraryStep = -1;
  let libraryFileId = "";
  let rejectFile = false;
  const fetcher: typeof fetch = async (url, init) => {
    if (init?.method === "DELETE") return Response.json({ deleted: true });
    if (String(url).endsWith("/conversations"))
      return Response.json({ id: "remote" });
    if (String(url).endsWith("/chat/completions"))
      return Response.json({
        choices: [
          { message: { content: "На фотографии подпись: Иван, 1910 год." } },
        ],
        usage: { prompt_tokens: 10, completion_tokens: 10 },
      });
    const body = JSON.parse(String(init?.body));
    requests.push(body);
    if (rejectFile)
      return Response.json(
        {
          error: {
            message: "attachment-test-secret",
            code: "unsupported_file",
          },
        },
        { status: 400 },
      );
    if (libraryStep === 0 || libraryStep === 1) {
      const step = libraryStep++;
      return Response.json({
        id: `library-${step}`,
        status: "completed",
        output: [
          {
            type: "function_call",
            call_id: `library-${step}`,
            name: "read_chat_attachments",
            arguments: JSON.stringify(step ? { fileIds: [libraryFileId] } : {}),
          },
        ],
      });
    }
    return Response.json({
      id: "answer",
      status: "completed",
      output_text:
        "В приложенных материалах есть сведения об Иване. Распознавание требует проверки.",
      usage: { input_tokens: 20, output_tokens: 10 },
    });
  };
  let app: Awaited<ReturnType<typeof startServer>> | undefined;
  try {
    app = await startServer(
      0,
      join(directory, "archive.sqlite"),
      true,
      undefined,
      fetcher,
    );
    const settings = await aiSettingsStore(app.archive.db),
      current = await settings.read();
    await settings.write(
      {
        ...current,
        roleProfiles: {
          ...current.roleProfiles,
          admin: { ...defaultAiRoleProfile(current), visionModel: "vision" },
        },
      },
      {
        id: "local",
        name: "Local",
        role: "admin",
        createdAt: "",
        approved: true,
      },
    );
    const cookies: Record<string, string> = {};
    for (const id of ["owner", "other"]) {
      await app.archive.db
        .prepare(
          "INSERT INTO users(id,name,role,approved) VALUES(?,?, 'admin',1)",
        )
        .run(id, id);
      const token = randomBytes(32).toString("hex");
      await app.archive.db
        .prepare(
          "INSERT INTO auth_sessions(token_hash,user_id,expires_at) VALUES(?,?,?)",
        )
        .run(
          createHash("sha256").update(token).digest("hex"),
          id,
          Date.now() + 600_000,
        );
      cookies[id] = `drevo_session=${token}`;
    }
    const request = (path: string, init?: RequestInit, user = "owner") =>
      fetch(
        `http://127.0.0.1:${(app!.server.address() as { port: number }).port}${path}`,
        {
          ...init,
          headers: {
            Cookie: cookies[user],
            Origin: env.PUBLIC_ORIGIN,
            ...init?.headers,
          },
        },
      );
    const post = (body: unknown) =>
      request("/api/ai/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
    const png = await sharp({
      create: { width: 2, height: 2, channels: 3, background: "white" },
    })
      .png()
      .toBuffer();
    const attached = [
      input("список.csv", "name,year\nИван,1910"),
      input("справка.pdf", "%PDF-1.4\nfixture"),
      input("фото.png", png),
    ];
    const response = await post({
      message: "Прочитай приложенный PDF и остальные материалы",
      attachments: attached,
    });
    assert.equal(response.status, 200, await response.clone().text());
    const result = await response.json();
    const rawInput = JSON.stringify(requests[0].input);
    assert.equal(
      (requests[0].tools as Array<{ name: string }>).some(
        (tool) => tool.name === "create_pdf",
      ),
      false,
      "reading an uploaded PDF must not trigger PDF generation",
    );
    assert.match(rawInput, /input_file/);
    assert.match(rawInput, /data:application\/pdf;base64/);
    assert.match(rawInput, /Иван,1910/);
    assert.match(rawInput, /На фотографии подпись/);
    assert.doesNotMatch(
      JSON.stringify(result),
      /attachment-test-secret|file_data|base64/,
    );
    const readChat = () =>
      request(`/api/ai/chats/${result.chatId}`).then((response) =>
        response.json(),
      );
    const chat = await readChat();
    assert.equal(chat.messages[0].attachments.length, 3);
    assert.equal(chat.messages[0].attachments[0].name, "список.csv");
    const url = chat.messages[0].attachments[0].url;
    libraryFileId = url.split("/").at(-1);
    const downloaded = await request(url);
    assert.equal(await downloaded.text(), "name,year\nИван,1910");
    assert.equal(downloaded.headers.get("x-content-type-options"), "nosniff");
    assert.match(downloaded.headers.get("content-disposition")!, /attachment/);
    assert.equal((await request(url, {}, "other")).status, 404);
    assert.equal((await request(url, { headers: { Cookie: "" } })).status, 401);
    assert.equal(
      (
        await request(
          url.replace(/[^/]+$/, "00000000-0000-0000-0000-000000000000"),
        )
      ).status,
      404,
    );
    await app.close();
    app = await startServer(
      0,
      join(directory, "archive.sqlite"),
      true,
      undefined,
      fetcher,
    );
    assert.equal(
      (await request(url)).status,
      200,
      "file persists after restart",
    );
    assert.deepEqual(
      (await readChat()).messages[0].attachments,
      chat.messages[0].attachments,
    );
    libraryStep = 0;
    const followup = await post({
      chatId: result.chatId,
      message: "Уточни вывод по файлу из библиотеки",
    });
    assert.equal(followup.status, 200);
    assert.match(JSON.stringify(requests.at(-1)?.input), /Иван,1910/);
    const calls = requests.length;
    assert.equal(
      (
        await post({
          chatId: result.chatId,
          message: "Прочитай",
          attachments: [{ url, data: "invalid", name: "a.txt" }],
        })
      ).status,
      400,
    );
    assert.equal(requests.length, calls);
    rejectFile = true;
    const rejectedFile = await post({
      chatId: result.chatId,
      message: "Прочитай PDF",
      attachments: [input("отказ.pdf", "%PDF-1.4\nfixture")],
    });
    assert.equal(rejectedFile.status, 502);
    const safeError = await rejectedFile.text();
    assert.match(safeError, /Модель ИИ не приняла вложение/);
    assert.doesNotMatch(safeError, /attachment-test-secret/);
    rejectFile = false;
    await app.archive.db
      .prepare("UPDATE users SET role='reader' WHERE id='owner'")
      .run();
    assert.equal(
      (await request(url)).status,
      404,
      "changed access scope cannot read old attachments",
    );
    const inaccessibleList = await request("/api/ai/chats").then((response) =>
      response.json(),
    );
    assert.equal(inaccessibleList.chats[0].unavailable, true);
    assert.equal(
      inaccessibleList.chats[0].title,
      "Диалог с прежними правами доступа",
    );
    assert.equal(
      (await request(`/api/ai/chats/${result.chatId}`, { method: "DELETE" }))
        .status,
      200,
    );
    assert.equal((await request(url)).status, 404);
    await app.archive.db
      .prepare("UPDATE users SET role='admin' WHERE id='owner'")
      .run();
    assert.equal(
      existsSync(join(directory, "uploads", "ai-chat-files", result.chatId)),
      false,
    );
    const store = aiChatStore(app.archive.db);
    const attempts = await Promise.allSettled(
      Array.from({ length: 11 }, () =>
        store.create("owner", '["admin","all",""]'),
      ),
    );
    assert.equal(
      attempts.filter((item) => item.status === "fulfilled").length,
      10,
    );
    const rejected = attempts.find(
      (item) => item.status === "rejected",
    ) as PromiseRejectedResult;
    assert.ok(rejected.reason instanceof AiChatLimitError);
    const limited = await post({ message: "Новый вопрос" });
    assert.equal(limited.status, 409);
    assert.equal((await limited.json()).code, "AI_CHAT_LIMIT");
    const firstChat = (await store.list("owner", '["admin","all",""]'))[0];
    assert.equal(
      (await request(`/api/ai/chats/${firstChat.id}`, { method: "DELETE" }))
        .status,
      200,
    );
    assert.equal((await post({ message: "Новый вопрос" })).status, 200);
  } finally {
    await app?.close();
    for (const [key, value] of Object.entries(old)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    rmSync(directory, { recursive: true, force: true });
  }
});

test("library selection accepts only files from this conversation", () => {
  const files = [
    {
      name: "a.txt",
      url: "/api/ai/attachments/chat/file-one",
      size: 100,
      type: "text/plain",
    },
  ];
  assert.deepEqual(selectChatAttachments(files, {}), []);
  assert.equal(
    selectChatAttachments(files, { fileIds: ["file-one", "file-one"] }).length,
    1,
  );
  assert.throws(
    () => selectChatAttachments(files, { fileIds: ["other-chat-file"] }),
    /недоступно/,
  );
  assert.throws(() => selectChatAttachments(files, { fileIds: "file-one" }));
  assert.throws(() => selectChatAttachments(files, { path: "/etc/passwd" }));
});

test("revoked AI access during vision model lookup prevents image submission", async () => {
  const image = await sharp({
    create: { width: 2, height: 2, channels: 3, background: "white" },
  }).png().toBuffer();
  let releaseModel!: () => void;
  let modelStarted!: () => void;
  const gate = new Promise<void>((resolve) => { releaseModel = resolve; });
  const started = new Promise<void>((resolve) => { modelStarted = resolve; });
  let allowed = true;
  let submissions = 0;
  const options = {
    files: [{ name: "photo.png", type: "image/png", size: image.length, url: "/file" }],
    chatId: "chat",
    store: { read: async () => image },
    runtime: { capabilities: { photoAnalysis: true } },
    vision: {
      modelUri: async () => { modelStarted(); await gate; return "gpt://folder/vision"; },
      analyze: async () => {
        submissions++;
        return { content: "image content", inputTokens: 1, outputTokens: 1 };
      },
    },
    metrics: { models: new Map() },
    signal: new AbortController().signal,
    question: "What is in the image?",
    assertAiAccess: async () => { if (!allowed) throw new Error("AI access revoked"); },
  } as unknown as Parameters<typeof researchAttachmentContext>[0];
  const reading = researchAttachmentContext(options);
  await started;
  allowed = false;
  releaseModel();
  await assert.rejects(reading, /AI access revoked/);
  assert.equal(submissions, 0);
});
