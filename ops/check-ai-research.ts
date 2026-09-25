import { writeFileSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve, join, dirname } from "node:path";
import { createHash, randomBytes } from "node:crypto";
import { startServer } from "../src/server/index.ts";
import type { Person } from "../src/domain/types.ts";
import { parseResearchMermaid } from "../src/domain/research-visual.ts";
if (
  !process.env.YANDEX_AI_API_KEY ||
  !process.env.YANDEX_AI_MODEL ||
  !process.env.YANDEX_AI_FOLDER_ID
)
  throw new Error(
    "Set YANDEX_AI_API_KEY, YANDEX_AI_FOLDER_ID and YANDEX_AI_MODEL. This script makes paid provider requests against synthetic data only.",
  );
delete process.env.PUBLIC_ORIGIN;
const scoped = process.argv.includes("--scoped");
if (scoped) process.env.PUBLIC_ORIGIN = "http://localhost";
delete process.env.NODE_ENV;
const directory = mkdtempSync(join(tmpdir(), "drevo-ai-eval-"));
const reportPath = resolve(
  process.env.DREVO_AI_EVAL_REPORT ||
    (scoped ? "work/ai-eval-reader.json" : "work/ai-eval-admin.json"),
);
mkdirSync(dirname(reportPath), { recursive: true });
const providerCalls: unknown[] = [];
const fetcher: typeof fetch = async (input, init) => {
  const response = await fetch(input, init);
  const body = await response
    .clone()
    .json()
    .catch(() => null);
  providerCalls.push({ status: response.status, output: body?.output });
  return response;
};
const app = await startServer(
  0,
  resolve(directory, "archive.sqlite"),
  true,
  undefined,
  fetcher,
);
const base = `http://127.0.0.1:${(app.server.address() as { port: number }).port}`;
const p = (
  id: string,
  name: string,
  birth: string,
  extra: Partial<Person> = {},
): Person => ({
  id,
  name,
  surname: "Тестов",
  patronymic: "",
  sex: "m",
  birth,
  birthPlace: "",
  parents: [],
  spouses: [],
  sources: [],
  generation: 1,
  column: 0,
  ...extra,
});
const people = [
  p("eval-root", "Николай", "1890-01-01", { death: "1970-01-01" }),
  p("eval-ivan", "Иван", "1920-01-01", {
    death: "1980-01-01",
    parents: ["eval-root"],
    generation: 2,
  }),
  p("eval-uncle", "Сергей", "1925-01-01", {
    death: "1995-01-01",
    parents: ["eval-root"],
    generation: 2,
  }),
  p("eval-anna", "Анна", "1960-07-13", {
    surname: "Тестова",
    sex: "f",
    parents: ["eval-ivan"],
    generation: 3,
  }),
  p("eval-brother", "Павел", "1965-01-01", {
    parents: ["eval-ivan"],
    generation: 3,
  }),
  p("eval-cousin", "Мария", "1963-01-01", {
    surname: "Тестова",
    sex: "f",
    parents: ["eval-uncle"],
    generation: 3,
  }),
  p("eval-child", "Алексей", "1968-01-01", {
    death: "1970-01-01",
    parents: ["eval-uncle"],
    generation: 3,
  }),
  p("eval-unknown", "Неизвестный", ""),
];
const current = app.archive.read();
app.archive.write(
  { ...current.family, people, photos: [], links: [] },
  current.revision,
);
app.archive.db
  .prepare(
    "UPDATE ai_settings SET requests_per_minute=100,daily_requests=500,daily_tokens=2000000",
  )
  .run();
let cookie = "";
if (scoped) {
  app.archive.db
    .prepare(
      "INSERT INTO users(id,name,role,approved,person_id,tree_access) VALUES('eval-reader','Анна','reader',1,'eval-anna','common_ancestors')",
    )
    .run();
  const token = randomBytes(32).toString("hex");
  app.archive.db
    .prepare(
      "INSERT INTO auth_sessions(token_hash,user_id,expires_at) VALUES(?,?,?)",
    )
    .run(
      createHash("sha256").update(token).digest("hex"),
      "eval-reader",
      Date.now() + 3600000,
    );
  cookie = `drevo_session=${token}`;
}
const queries: Array<{ message: string; group?: string }> = scoped
  ? [
      { message: "сколько мне лет?" },
      { message: "кем мне приходится мария тестова" },
      { message: "у меня есть братья?" },
      { message: "покажи график продолжительности жизни" },
      { message: "перечисли всех людей из доступного мне архива" },
      { message: "дай полную карточку Неизвестного Тестова" },
      { message: "измени Анне Тестовой год рождения на 1961" },
      { message: "покажи диаграмму людей по десятилетиям рождения" },
    ]
  : [
      { message: "нук раскидай мне граф продолжительности жизни" },
      { message: "сколько людей тут", group: "list" },
      { message: "перечисли", group: "list" },
      { message: "сколько поколений в базе" },
      { message: "у анны тестовой есть братья", group: "siblings" },
      { message: "а двоюродные", group: "siblings" },
      { message: "покажи граф родства Анны Тестовой и Марии Тестовой" },
      { message: "покажи фото Ивана Тестова" },
      { message: "покажи только тестовых на древе" },
      { message: "трутуту" },
      { message: "измени Анне Тестовой год рождения на 1961" },
    ];
const groups = new Map<string, string>();
const results: unknown[] = [];
try {
  for (const q of queries) {
    const started = Date.now(),
      before = providerCalls.length;
    const response = await fetch(`${base}/api/ai/chat`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(scoped ? { Origin: "http://localhost", Cookie: cookie } : {}),
      },
      body: JSON.stringify({
        message: q.message,
        chatId: q.group ? groups.get(q.group) : undefined,
        context: {
          view: "tree",
          personIds: ["eval-anna"],
          openPersonId: "eval-anna",
          timeZone: "Europe/Moscow",
        },
      }),
      signal: AbortSignal.timeout(150000),
    });
    const data = await response.json();
    if (q.group && data.chatId) groups.set(q.group, data.chatId);
    const visuals = [];
    for (const block of String(data.answer || "").matchAll(
      /```mermaid\s*\n([\s\S]*?)```/g,
    )) {
      try {
        visuals.push(parseResearchMermaid(block[1]));
      } catch (error) {
        visuals.push({ error: String(error) });
      }
    }
    const result = {
      question: q.message,
      status: response.status,
      ms: Date.now() - started,
      ...data,
      visuals,
      calls: providerCalls.slice(before),
    };
    results.push(result);
    writeFileSync(reportPath, JSON.stringify(results, null, 2));
    console.log(
      JSON.stringify({
        question: q.message,
        status: response.status,
        answer: data.answer,
        error: data.error,
        visuals,
        suggestions: data.suggestionIds,
        uiActions: data.uiActions,
        calls: providerCalls.length - before,
      }),
    );
  }
} finally {
  await app.close();
  if (
    dirname(directory) !== resolve(tmpdir()) ||
    !directory.startsWith(join(tmpdir(), "drevo-ai-eval-"))
  )
    throw new Error("Unexpected diagnostic directory");
  rmSync(directory, { recursive: true, force: true });
}
