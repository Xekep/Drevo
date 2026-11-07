import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startServer } from "../src/server/index.ts";
import { researchSuggestionStore } from "../src/server/research-suggestions.ts";
import type { ArchiveUser } from "../src/domain/access.ts";
import type { Family, Person } from "../src/domain/types.ts";

test("batch proposals validate identities, roll back on failure, and never apply without acceptance", async () => {
  const dir = mkdtempSync(join(tmpdir(), "drevo-batch-suggestions-"));
  const app = await startServer(0, join(dir, "archive.sqlite"), true);
  const actor = {
    id: "local",
    role: "admin",
    name: "Администратор",
    approved: true,
    createdAt: "",
  } as ArchiveUser;
  const person = (id: string, name: string): Person => ({
    id,
    surname: "Лебедь",
    name,
    patronymic: "Иванович",
    sex: "m",
    birth: "1900",
    birthPlace: "Старое",
    parents: [],
    spouses: [],
    generation: 1,
    column: 0,
    sources: [],
  });
  try {
    const initial = await app.archive.read();
    const family: Family = {
      ...initial.family,
      people: [...initial.family.people, person("person-a", "Павел"), person("person-b", "Александр")],
    };
    await app.archive.write(family, initial.revision);
    const snapshot = await app.archive.read();
    const suggestions = researchSuggestionStore(app.archive.db);
    const update = (id: string, name: string, place: string) => ({
      personId: id,
      personName: name,
      changes: { birthPlace: place },
      reason: "Уточнение исторического названия места рождения",
      evidence: ["Проверено по приложенной ведомости"],
    });
    const correct = update("person-a", "Лебедь Павел Иванович", "Новое");
    const another = update("person-b", "Лебедь Александр Иванович", "Другое");
    const execute = (updates: unknown[]) =>
      suggestions.createFromTool(
        "propose_person_updates_batch",
        actor,
        snapshot.family,
        snapshot.revision,
        { updates },
      );

    await assert.rejects(
      execute([correct, update("person-b", "Лебедь Павел Иванович", "Другое")]),
      /ФИО не соответствует/,
    );
    await assert.rejects(
      execute([correct, correct]),
      /дважды указана/,
    );
    // The first proposal would be valid, but the second would not change
    // anything. No orphaned first proposal must remain after rollback.
    await assert.rejects(
      execute([correct, update("person-b", "Лебедь Александр Иванович", "Старое")]),
      /уже записаны/,
    );
    assert.deepEqual(await suggestions.list(actor), []);

    const created = await execute([correct, another]);
    assert.equal(Array.isArray(created), true);
    if (!Array.isArray(created)) throw new Error("Batch returned one proposal");
    assert.equal(created.length, 2);
    assert.equal(new Set(created.map(item => item.id)).size, 2);
    assert.ok(created.every(item => item.status === "pending" && item.kind === "person_update"));
    assert.equal((await suggestions.list(actor)).length, 2);
    const unchanged = await app.archive.read();
    assert.equal(unchanged.family.people.find(item => item.id === "person-a")?.birthPlace, "Старое");
    assert.equal(unchanged.family.people.find(item => item.id === "person-b")?.birthPlace, "Старое");
  } finally {
    await app.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
