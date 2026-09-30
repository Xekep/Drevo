import test from "node:test";
import assert from "node:assert/strict";
import { calculationData } from "../src/domain/calculation-data.ts";
import type { Family, Person } from "../src/domain/types.ts";
import { projectFamilyForUser } from "../src/domain/tree-access.ts";
import { runCodeInterpreter } from "../src/server/code-interpreter.ts";
import { yandexResponsesClient } from "../src/server/yandex-responses.ts";

const person = (id: string, extra: Partial<Person> = {}): Person => ({
  id,
  name: "Имя",
  surname: "Фамилия",
  patronymic: "",
  sex: "u",
  birth: "1900",
  birthPlace: "",
  parents: [],
  spouses: [],
  generation: 1,
  column: 0,
  sources: [],
  ...extra,
});
const family: Family = {
  title: "Архив",
  description: "",
  demo: false,
  people: [
    person("visible", { parents: ["private"], biography: "private-notes" }),
    person("private", { surname: "Секрет" }),
  ],
};
const runtime = {
  baseUrl: "https://example.test/v1",
  apiKey: "secret-api-key",
  folderId: "folder",
  modelUri: "gpt://folder/model",
};
const success = () => ({
  status: "completed",
  usage: { input_tokens: 23, output_tokens: 45 },
  output: [
    {
      type: "code_interpreter_call",
      status: "completed",
      container_id: "container-new",
    },
    {
      type: "message",
      content: [
        {
          type: "output_text",
          text: "Посчитано 2 человека. [Таблица](sandbox:/mnt/data/result.csv)",
          annotations: [
            {
              type: "container_file_citation",
              container_id: "container-new",
              file_id: "file-output",
              filename: "../../result.csv",
            },
            {
              type: "container_file_citation",
              container_id: "another-user",
              file_id: "foreign-file",
              filename: "private.csv",
            },
          ],
        },
      ],
    },
  ],
});

test("calculation data contains only selected authorized fields and relationships", () => {
  const visible = projectFamilyForUser(family, {
    id: "reader",
    role: "reader",
    approved: true,
    name: "",
    createdAt: "",
    treeAccess: "common_ancestors",
  });
  assert.equal(calculationData(visible, ["surname"], undefined).totalPeople, 0);
  const result = calculationData(family, ["birth", "parents"], ["visible"]);
  assert.deepEqual(result.people, [
    { id: "visible", birth: "1900", parents: [] },
  ]);
  assert.doesNotMatch(JSON.stringify(result), /private|Секрет|notes/);
  assert.deepEqual(calculationData(family, [], undefined).people, []);
  assert.throws(() => calculationData(family, ["notes"], undefined));
  assert.throws(() => calculationData(family, ["surname"], ["missing"]));
});

test("Yandex wire format, usage, safe artifacts and cleanup use the existing server client", async () => {
  const deleted: string[] = [],
    fetched: string[] = [];
  let calls = 0,
    usage: number[] = [];
  const client = yandexResponsesClient(async (url, init) => {
    assert.equal(init?.redirect, "error");
    const path = new URL(String(url)).pathname;
    if (init?.method === "DELETE") {
      deleted.push(path);
      return Response.json({ deleted: true });
    }
    if (path === "/v1/files") {
      assert.ok(init?.body instanceof FormData);
      assert.equal(new Headers(init.headers).has("content-type"), false);
      assert.equal(init.body.get("purpose"), "user_data");
      assert.equal(init.body.get("expires_after[seconds]"), "86400");
      const data = JSON.parse(await (init.body.get("file") as Blob).text());
      assert.equal(data.totalPeople, 2);
      assert.doesNotMatch(JSON.stringify(data), /secret-api-key|private-notes/);
      return Response.json({ id: "file-input" });
    }
    if (path === "/v1/responses") {
      const body = JSON.parse(String(init?.body));
      assert.equal(body.conversation, undefined);
      assert.equal(body.model, runtime.modelUri);
      assert.deepEqual(body.tools, [
        {
          type: "code_interpreter",
          container: {
            type: "auto",
            memory_limit: "1g",
            network_policy: { type: "disabled" },
            file_ids: ["file-input"],
          },
        },
      ]);
      assert.equal(body.max_tool_calls, 4);
      assert.equal(body.max_output_tokens, 16000);
      return Response.json(success());
    }
    fetched.push(path);
    return new Response("year,count\n1900,2");
  });
  const result = await runCodeInterpreter({
    client,
    runtime,
    family,
    input: { task: "Посчитай", fields: ["birth"] },
    signal: new AbortController().signal,
    allowPdf: true,
    onCall: () => calls++,
    onUsage: (...values) => {
      usage = values;
    },
  });
  assert.equal(calls, 1);
  assert.deepEqual(usage, [23, 45]);
  assert.equal(result.files[0].name, "result.csv");
  assert.equal(result.files[0].contentType, "text/csv; charset=utf-8");
  assert.match(result.files[0].bytes.toString(), /1900,2/);
  assert.doesNotMatch(
    JSON.stringify(result),
    /secret-api-key|foreign-file|sandbox:/,
  );
  assert.deepEqual(fetched, ["/v1/files/file-output/content"]);
  assert.deepEqual(deleted.sort(), [
    "/v1/files/file-input",
    "/v1/files/file-output",
  ]);
});

for (const [status, code] of [
  [401, "CALCULATION_ACCESS_DENIED"],
  [429, "CALCULATION_RATE_LIMITED"],
  [503, "CALCULATION_UNAVAILABLE"],
  [400, "CALCULATION_UNSUPPORTED"],
] as const)
  test(`provider ${status} is controlled and does not expose credentials`, async () => {
    const result = await runCodeInterpreter({
      client: yandexResponsesClient(async () =>
        Response.json({ error: { message: runtime.apiKey } }, { status }),
      ),
      runtime,
      family,
      input: { task: "1+1", fields: [] },
      signal: new AbortController().signal,
      allowPdf: true,
      onCall() {},
      onUsage() {},
    });
    assert.equal(result.error, code);
    assert.doesNotMatch(JSON.stringify(result), /secret-api-key/);
  });

for (const abort of [false, true])
  test(`bounded waiting and cancellation clean up uploaded data (user stop: ${abort})`, async () => {
    const controller = new AbortController();
    let cleaned = false;
    const client = yandexResponsesClient(async (url, init) => {
      if (init?.method === "DELETE") {
        cleaned = true;
        assert.equal(init.signal?.aborted, false);
        return Response.json({ deleted: true });
      }
      if (String(url).endsWith("/files")) return Response.json({ id: "input" });
      return new Promise<Response>((_, reject) => {
        init?.signal?.addEventListener(
          "abort",
          () => reject(init.signal!.reason),
          { once: true },
        );
        if (abort) controller.abort(new DOMException("Stop", "AbortError"));
      });
    });
    const pending = runCodeInterpreter({
      client,
      runtime,
      family,
      input: { task: "Считай", fields: ["birth"] },
      signal: controller.signal,
      timeoutMs: 25,
      allowPdf: true,
      onCall() {},
      onUsage() {},
    });
    // Keep the event loop alive while testing AbortSignal.timeout's unref'ed timer.
    const keepAlive = setTimeout(() => {}, 1000);
    try {
      if (abort) await assert.rejects(pending, { name: "AbortError" });
      else assert.equal((await pending).error, "CALCULATION_TIMEOUT");
      assert.equal(cleaned, true);
    } finally {
      clearTimeout(keepAlive);
    }
  });

test("no executed code, incomplete responses and malformed data are not successful calculations", async () => {
  for (const raw of [
    { status: "completed", output: [] },
    { ...success(), status: "incomplete" },
    null,
  ]) {
    const result = await runCodeInterpreter({
      client: yandexResponsesClient(async (_url, init) =>
        Response.json(init?.method === "DELETE" ? { deleted: true } : raw),
      ),
      runtime,
      family,
      input: { task: "1+1", fields: [] },
      signal: new AbortController().signal,
      allowPdf: false,
      onCall() {},
      onUsage() {},
    });
    assert.ok(result.error);
    assert.deepEqual(result.files, []);
  }
});

test("unsupported and oversized attachments are not exposed; PDF capability is respected", async () => {
  const raw = success();
  raw.output[1].content![0].annotations = [
    {
      type: "container_file_citation",
      container_id: "container-new",
      file_id: "big",
      filename: "big.csv",
    },
    {
      type: "container_file_citation",
      container_id: "container-new",
      file_id: "pdf",
      filename: "report.pdf",
    },
    {
      type: "container_file_citation",
      container_id: "container-new",
      file_id: "html",
      filename: "page.html",
    },
  ];
  let downloads = 0;
  const result = await runCodeInterpreter({
    client: yandexResponsesClient(async (url, init) => {
      if (init?.method === "DELETE") return Response.json({ deleted: true });
      if (String(url).endsWith("/responses")) return Response.json(raw);
      downloads++;
      return new Response("tiny", {
        headers: { "content-length": String(11 * 1024 * 1024) },
      });
    }),
    runtime,
    family,
    input: { task: "1+1", fields: [] },
    signal: new AbortController().signal,
    allowPdf: false,
    onCall() {},
    onUsage() {},
  });
  assert.equal(downloads, 1);
  assert.deepEqual(result.files, []);
  assert.ok(result.warnings?.length);
});
