import { join } from "node:path";
import { Readable } from "node:stream";
import type { Family } from "../../src/domain/types.ts";
import type { startServer } from "../../src/server/index.ts";
import { mediaStore } from "../../src/server/media.ts";
import { indexReferencedMediaOriginals } from "../../src/server/media-originals.ts";
import { randomFamily } from "../layout-fixtures.ts";
import { renderPortraits } from "./render-portraits.ts";

/** Synthetic archive and originals, confined to the E2E server's temporary root. */
export async function seedTreeAcceptanceFixture(
  archive: Awaited<ReturnType<typeof startServer>>["archive"],
  directory: string,
  requestedPeople = process.env.DREVO_TREE_ACCEPTANCE_PEOPLE || "977",
) {
  if (requestedPeople !== "977" && requestedPeople !== "3313")
    throw new Error("DREVO_TREE_ACCEPTANCE_PEOPLE должен быть 977 или 3313");
  const people = randomFamily(5, requestedPeople === "977" ? 9 : 12);
  if (people.length !== Number(requestedPeople))
    throw new Error("Размер воспроизводимой семьи изменился");
  const images = await renderPortraits(people.map((person) => person.id));
  const media = mediaStore(join(directory, "uploads"));
  const family: Family = {
    title: `Синтетический архив: ${requestedPeople} человек`,
    description:
      "Проверка production-приложения; реальные данные не используются.",
    demo: false,
    people: [],
    unions: [],
    links: [],
    photos: [],
  };
  for (const [index, person] of people.entries()) {
    // Use 400px originals: the real backend generates/caches each requested
    // preview. Pre-generated tiny images must not warm its preview directory.
    const bytes = images.get(`${person.id}-thumb`)!;
    const original = await media.addStream(Readable.from([bytes]), 1024 * 1024);
    family.people.push({
      ...person,
      name: person.id,
      surname: "Тестов",
      patronymic: "",
      sex: index % 2 ? "m" : "f",
      birthPlace: "",
      generation: 1,
      column: 0,
      sources: [],
      needsReview: index % 11 === 0,
      photo: original.url,
    });
    images.delete(`${person.id}-thumb`);
    images.delete(`${person.id}-tiny`);
  }
  // startServer indexed the initially empty archive before fixture seeding.
  const indexed = await indexReferencedMediaOriginals(
    archive.db,
    family,
    media,
  );
  if (indexed.missing || indexed.indexed !== family.people.length)
    throw new Error("Не все тестовые оригиналы фотографий проиндексированы");
  // Publish last: the benchmark's overview-count readiness check must observe
  // a complete fixture, with no remaining setup writes in its load timings.
  const current = await archive.read();
  await archive.write(family, current.revision);
  console.log(
    `E2E acceptance: ${family.people.length} человек с JPEG-портретами`,
  );
}
