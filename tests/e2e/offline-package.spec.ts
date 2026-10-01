import { test, expect } from "@playwright/test";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import sharp from "sharp";
import { offlineReaderHtml } from "../../src/server/offline-reader.ts";
import type { Family } from "../../src/domain/types.ts";

test("standalone archive opens people, photos, documents and places without a server", async ({
  page,
}) => {
  const directory = await mkdtemp(join(tmpdir(), "drevo-offline-browser-"));
  const photo = "11111111-1111-1111-1111-111111111111.png";
  const pdf = "22222222-2222-2222-2222-222222222222.pdf";
  const family: Family = {
    title: "Семейный архив",
    description: "",
    demo: false,
    people: [
      {
        id: "anna",
        name: "Анна",
        surname: "Тестова",
        patronymic: "",
        sex: "f",
        birth: "1900",
        birthPlace: "Москва",
        parents: [],
        spouses: [],
        generation: 1,
        column: 0,
        sources: [],
        photo: `media/${photo}`,
      },
      {
        id: "boris",
        name: "Борис",
        surname: "Тестов",
        patronymic: "",
        sex: "m",
        birth: "1930",
        birthPlace: "Москва",
        parents: ["anna"],
        spouses: [],
        generation: 2,
        column: 0,
        sources: [],
      },
    ],
    photos: [
      {
        id: "photo",
        url: `media/${photo}`,
        title: "Семейный снимок",
        tags: [
          { id: "tag", personId: "anna", x: 0, y: 0, width: 1, height: 1 },
        ],
      },
    ],
    links: [],
  };
  const errors: string[] = [];
  const network: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("request", (request) => {
    if (/^https?:/.test(request.url())) network.push(request.url());
  });
  try {
    await mkdir(join(directory, "media"));
    await writeFile(
      join(directory, "index.html"),
      offlineReaderHtml(family, [
        {
          id: "doc",
          title: "Метрическая запись",
          file: `media/${pdf}`,
          createdAt: "2026-01-01",
          personIds: ["anna"],
        },
      ]),
    );
    await writeFile(
      join(directory, "media", photo),
      await sharp({
        create: { width: 24, height: 24, channels: 3, background: "green" },
      })
        .png()
        .toBuffer(),
    );
    await writeFile(join(directory, "media", pdf), Buffer.from("%PDF-1.4\n"));
    await page.goto(pathToFileURL(join(directory, "index.html")).href);
    await expect(
      page.getByRole("heading", { name: "Семейный архив" }),
    ).toBeVisible();
    await page.getByRole("searchbox").fill("Борис");
    await expect(page.locator("#summary")).toHaveText("Найдено: 1");
    await expect(
      page.getByRole("heading", { name: "Тестов Борис" }),
    ).toBeVisible();
    await page.getByRole("button", { name: "Тестова Анна" }).click();
    await expect(
      page.getByRole("heading", { name: "Тестова Анна" }),
    ).toBeVisible();
    await page.getByRole("button", { name: "Фото", exact: true }).click();
    await expect(
      page.getByRole("heading", { name: "Семейный снимок" }),
    ).toBeVisible();
    await expect(page.locator(".large-photo")).toHaveJSProperty(
      "naturalWidth",
      24,
    );
    await page.getByRole("button", { name: "Документы", exact: true }).click();
    await expect(
      page.getByRole("link", { name: "Открыть оригинал" }),
    ).toHaveAttribute("href", `media/${pdf}`);
    await page.getByRole("button", { name: "Места", exact: true }).click();
    await expect(page.getByRole("heading", { name: "Москва" })).toBeVisible();
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= window.innerWidth,
      ),
    ).toBe(true);
    expect(errors).toEqual([]);
    expect(network).toEqual([]);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
