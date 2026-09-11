import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import sharp from "sharp";
import {
  photoAlbums,
  newestPhotos,
  viewerPhotos,
} from "../src/domain/photo-albums.ts";
import { photoFileError } from "../src/domain/photo-upload.ts";
import { photoCaption, photoLabel } from "../src/domain/photo-metadata.ts";
import { familyPlaces } from "../src/domain/places.ts";
import { portraitCrop } from "../src/domain/portrait-crop.ts";
import { mediaPreview } from "../src/domain/media-preview.ts";
import { imagePreviews } from "../src/server/image-previews.ts";
import { findPeople } from "../src/domain/people-search.ts";
import {
  archiveOverview,
  personDetails,
} from "../src/domain/archive-projection.ts";
import { completeArchive } from "../src/data/archive-pages.ts";
import { parentHints, siblingHints } from "../src/domain/name-hints.ts";
import type { Person, ArchivePhoto, Family } from "../src/domain/types.ts";

const person = (id: string, patch: Partial<Person> = {}): Person => ({
  id,
  name: "Анна",
  surname: "Соколова",
  patronymic: "Ивановна",
  sex: "f",
  birth: "",
  birthPlace: "",
  parents: [],
  spouses: [],
  generation: 1,
  column: 0,
  sources: [],
  ...patch,
});
const photo = (
  id: string,
  patch: Partial<ArchivePhoto> = {},
): ArchivePhoto => ({
  id,
  url: `/media/${id}.png`,
  title: "Старое название",
  tags: [],
  ...patch,
});
const tag = (id: string, personId: string) => ({
  id,
  personId,
  x: 0,
  y: 0,
  width: 0.2,
  height: 0.2,
});
const family = (): Family => ({
  title: "Архив",
  description: "",
  demo: false,
  people: [
    person("a", {
      biography: "Биография",
      occupation: "Работа",
      awards: [{ id: "award", name: "Награда" }],
      sources: [{ title: "Архив", type: "Документ", reference: "Лист" }],
    }),
    person("b", { parents: ["a"] }),
  ],
  photos: [photo("p", { tags: [tag("t", "a")] })],
});

test("photo albums preserve addition order, deduplicate tags, and separate unknown years", () => {
  const people = [person("a"), person("b", { name: "Борис" })];
  const photos = [
    photo("old", { year: "1950" }),
    photo("newer", { takenAt: "лето 1960" }),
    photo("dated", {
      createdAt: "2026-09-10T10:00:00Z",
      takenAt: "1990-10-10",
      tags: [tag("a", "a"), tag("b", "a"), tag("c", "b")],
    }),
  ];
  const before = structuredClone(photos);
  assert.deepEqual(
    newestPhotos(photos).map((p) => p.id),
    ["dated", "newer", "old"],
  );
  assert.deepEqual(
    photoAlbums(photos, people, "years").map((a) => a.label),
    ["1990", "1950", "Год не указан"],
  );
  const albums = photoAlbums(photos, people, "people");
  assert.equal(albums.find((a) => a.id === "a")!.photos.length, 1);
  assert.equal(albums.at(-1)!.photos.length, 2);
  assert.deepEqual(photos, before);
  assert.equal(photoCaption(photo("p")), "");
  assert.equal(photoLabel(photo("p")), "Семейная фотография");
  assert.equal(
    photoCaption(photo("p", { place: "Москва", event: "  " })),
    "Москва",
  );
});

test("viewer keeps album order and excludes deleted photos, duplicates and unrelated uploads", () => {
  const photos = [photo("old"), photo("selected"), photo("new")];
  const collection = ["selected", "deleted", "old", "selected"];
  assert.deepEqual(
    viewerPhotos(photos, "selected", collection).map((p) => p.id),
    ["selected", "old"],
  );
  assert.deepEqual(
    viewerPhotos(photos, "old", collection).map((p) => p.id),
    ["selected", "old"],
  );
  assert.deepEqual(
    viewerPhotos(photos, "new", collection).map((p) => p.id),
    ["new", "selected", "old"],
  );
  assert.deepEqual(
    viewerPhotos(photos, "old").map((p) => p.id),
    ["new", "selected", "old"],
  );
  assert.deepEqual(viewerPhotos([], "deleted", collection), []);
  assert.deepEqual(collection, ["selected", "deleted", "old", "selected"]);
});

test("dropped photos use the same size and format limits as the upload picker", () => {
  for (const type of ["image/jpeg", "image/png", "image/webp", "image/gif"])
    assert.equal(photoFileError({ type, size: 20 * 1024 * 1024 }), "");
  for (const file of [
    { type: "image/png", size: 0 },
    { type: "image/png", size: 20 * 1024 * 1024 + 1 },
    { type: "image/svg+xml", size: 1024 },
    { type: "text/html", size: 1024 },
  ])
    assert.ok(photoFileError(file));
});

test("photo places merge with people places without inventing life events for tagged people", () => {
  const p = person("a", {
    birthPlace: "Москва",
    birthLocation: { place: "Москва", lat: 55, lon: 37 },
  });
  const photos = [
    photo("a", { place: "г. Москва" }),
    photo("b", { place: "Казань", tags: [tag("t", "a")] }),
    photo("c", { place: "  " }),
  ];
  const places = familyPlaces([p], photos);
  assert.equal(places.length, 2);
  assert.equal(places[0].photos.length, 1);
  assert.equal(places[0].events.length, 1);
  assert.equal(places[0].location!.lat, 55);
  assert.equal(places[1].events.length, 0);
  assert.equal(places[1].photos[0].id, "b");
  assert.equal(familyPlaces([], photos)[0].events.length, 0);
});

test("portrait crop stays square and inside the original even at extreme positions", () => {
  assert.deepEqual(portraitCrop(1200, 800, 1, 0.5, 0.5), {
    x: 200,
    y: 0,
    width: 800,
    height: 800,
  });
  for (const zoom of [-1, 1, 2, 8])
    for (const center of [-1, 0, 0.5, 1, 2]) {
      const crop = portraitCrop(800, 1200, zoom, center, center);
      assert.equal(crop.width, crop.height);
      assert.ok(
        crop.x >= 0 &&
          crop.y >= 0 &&
          crop.x + crop.width <= 800 &&
          crop.y + crop.height <= 1200,
      );
    }
  assert.equal(mediaPreview("/media/abc.png"), "/media/abc.png?variant=thumb");
  for (const url of [
    "/media/abc.gif",
    "https://example.com/photo.png",
    "blob:abc",
  ])
    assert.equal(mediaPreview(url), url);
});

test("lossless WebP retains decoded pixels when not resized, caches once and leaves originals intact", async () => {
  const directory = mkdtempSync(join(tmpdir(), "drevo-previews-"));
  try {
    const original = await sharp({
      create: {
        width: 8,
        height: 7,
        channels: 3,
        background: { r: 125, g: 91, b: 47 },
      },
    })
      .png()
      .toBuffer();
    const before = Buffer.from(original),
      preview = imagePreviews(directory);
    const [a, b] = await Promise.all([
      preview(original, "thumb"),
      preview(original, "thumb"),
    ]);
    assert.deepEqual(a, b);
    assert.deepEqual(
      await sharp(a).raw().toBuffer(),
      await sharp(original).raw().toBuffer(),
    );
    assert.equal((await sharp(a).metadata()).format, "webp");
    assert.equal(readdirSync(directory).length, 1);
    assert.deepEqual(original, before);
    const large = await sharp({
      create: { width: 2000, height: 1000, channels: 3, background: "red" },
    })
      .png()
      .toBuffer();
    const small = await sharp(await preview(large, "thumb")).metadata();
    assert.equal(small.width, 400);
    assert.equal(small.height, 200);
    const display = await sharp(await preview(large, "display")).metadata();
    assert.equal(display.width, 1600);
    assert.equal(display.height, 800);
    await assert.rejects(preview(Buffer.from("broken image"), "thumb"));
    assert.deepEqual(
      await preview(original, "thumb"),
      a,
      "ошибка не блокирует очередь",
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("person search supports birth surnames, yo, mixed tokens and bounded minimal results", () => {
  const people = [
    person("a", {
      name: "Алёна",
      maidenName: "Петрова",
      biography: "Секретное слово",
    }),
    ...Array.from({ length: 25 }, (_, i) => person(`p${i}`)),
  ];
  assert.equal(findPeople(people, "алена петр").people[0].id, "a");
  assert.equal(findPeople(people, "Секретное").people.length, 0);
  assert.equal(findPeople(people, "а").people.length, 0);
  const result = findPeople(people, "сокол");
  assert.equal(result.people.length, 20);
  assert.equal(result.hasMore, true);
  assert.deepEqual(Object.keys(result.people[0]).sort(), [
    "detail",
    "id",
    "label",
  ]);
});

test("staged loading preserves all topology first and merges only complete consistent pages", async () => {
  const full = family(),
    overview = archiveOverview(full),
    before = structuredClone(full);
  assert.equal(overview.photos!.length, 0);
  assert.deepEqual(overview.people[1].parents, full.people[1].parents);
  assert.equal(overview.people[0].biography, undefined);
  assert.equal(overview.people[0].awards, undefined);
  const initial = {
    family: overview,
    revision: 7,
    partial: true,
    pageToken: "7:1:1",
    totals: { people: 2, photos: 1 },
  };
  const updates: Family[] = [];
  const result = await completeArchive(
    initial,
    async (url) => {
      const p = new URL(url, "http://localhost").searchParams;
      const collection = p.get("collection") as "people" | "photos",
        offset = Number(p.get("offset"));
      return Response.json({
        pageToken: initial.pageToken,
        total: initial.totals[collection],
        items:
          collection === "people"
            ? full.people.slice(offset, offset + 1).map(personDetails)
            : full.photos!.slice(offset, offset + 1),
      });
    },
    (data) => updates.push(data),
  );
  assert.deepEqual(result.family, full);
  assert.equal(updates.length, 2);
  assert.equal(result.partial, false);
  assert.deepEqual(full, before);
  for (const bad of [
    { pageToken: "8:1:1", total: 2, items: full.people },
    { pageToken: initial.pageToken, total: 2, items: [] },
    {
      pageToken: initial.pageToken,
      total: 2,
      items: [full.people[0], full.people[0]],
    },
    { pageToken: initial.pageToken, total: 2, items: [person("foreign")] },
    { pageToken: initial.pageToken, total: 3, items: full.people },
  ])
    await assert.rejects(
      completeArchive(
        initial,
        async () => Response.json(bad),
        () => assert.fail("некорректная страница опубликована"),
      ),
    );
  await assert.rejects(
    completeArchive(
      initial,
      async () => Response.json({ error: "Доступ закрыт" }, { status: 401 }),
      () => assert.fail(),
    ),
  );
});

test("patronymic alone and married surname do not imply paternity; a known mother supplies context", () => {
  const father = person("father", {
    sex: "m",
    name: "Иван",
    surname: "Петров",
    birth: "1960",
  });
  const child = person("child", { birth: "1990" });
  assert.equal(parentHints(child, [father]).length, 0);
  assert.equal(
    parentHints({ ...child, surname: "Петрова", maidenName: "Соколова" }, [
      father,
    ]).length,
    0,
  );
  const mother = person("mother", {
    name: "Мария",
    birth: "1960",
    spouses: [father.id],
  });
  const dad = { ...father, spouses: [mother.id] };
  assert.equal(
    parentHints({ ...child, parents: [mother.id] }, [dad, mother]).length,
    1,
  );
  const sibling = person("sibling", { parents: [father.id, mother.id] });
  assert.equal(
    parentHints({ ...child, parents: [mother.id] }, [father, mother, sibling])
      .length,
    1,
  );
});

test("known collateral branches are not suggested as parents or siblings from repeated names", () => {
  const grandma = person("grandma", { name: "Мария" });
  const mother = person("mother", { name: "Ольга", parents: [grandma.id] });
  const uncle = person("uncle", {
    name: "Иван",
    sex: "m",
    surname: "Соколов",
    parents: [grandma.id],
  });
  const child = person("child", { parents: [mother.id] });
  const cousin = person("cousin", {
    name: "Пётр",
    surname: "Соколов",
    patronymic: "Иванович",
    parents: [uncle.id],
  });
  const people = [grandma, mother, uncle, child, cousin];
  assert.equal(
    parentHints(child, people).some((h) => h.from === uncle.id),
    false,
  );
  assert.equal(
    siblingHints(child, people).some((h) => h.person.id === cousin.id),
    false,
  );
});
