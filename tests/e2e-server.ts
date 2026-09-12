import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startServer } from "../src/server/index.ts";

const directory = mkdtempSync(join(tmpdir(), "drevo-e2e-"));
const app = await startServer(4173, join(directory, "drevo.sqlite"), true);
const current = app.archive.read();
app.archive.write(
  {
    ...current.family,
    people: [
      {
        id: "e2e-memorial-person",
        surname: "Тестов",
        name: "Иван",
        patronymic: "Петрович",
        sex: "m",
        birth: "1940-01-01",
        death: "2020-01-01",
        birthPlace: "Москва",
        parents: [],
        spouses: [],
        generation: 1,
        column: 0,
        sources: [],
      },
      {
        id: "e2e-child",
        surname: "Тестов",
        name: "Пётр",
        patronymic: "Иванович",
        sex: "m",
        birth: "1965-01-01",
        birthPlace: "Москва",
        parents: ["e2e-memorial-person"],
        spouses: [],
        generation: 2,
        column: 0,
        sources: [],
      },
      {
        id: "e2e-grandchild",
        surname: "Тестова",
        name: "Анна",
        patronymic: "Петровна",
        sex: "f",
        birth: "1990-01-01",
        birthPlace: "Москва",
        parents: ["e2e-child"],
        spouses: [],
        generation: 3,
        column: 0,
        sources: [],
      },
    ],
  },
  current.revision,
);
let closing = false;

async function close() {
  if (closing) return;
  closing = true;
  await app.close();
  rmSync(directory, { recursive: true, force: true });
}

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    void close().then(() => process.exit(0));
  });
}

process.on("uncaughtException", (error) => {
  console.error(error);
  void close().then(() => process.exit(1));
});
