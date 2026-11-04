import { readFileSync } from "node:fs";
import { expect, test } from "@playwright/test";
import sharp from "sharp";
import type { Person } from "../../src/domain/types";
import { profileTreeRenderer } from "./tree-render-profile";

// Opt-in local snapshot: retain topology, anonymize IDs/names before it enters
// the browser. No family data or snapshots are checked into the repository.
test.use({ trace: "off" });
test("profile camera gestures on a supplied small family graph", async ({ page }, info) => {
  test.skip(!process.env.DREVO_PAN_GRAPH);
  test.setTimeout(240_000);
  if (process.env.DREVO_PAN_WIDTH) await page.setViewportSize({ width: Number(process.env.DREVO_PAN_WIDTH), height: Number(process.env.DREVO_PAN_HEIGHT || 1440) });
  const graph = JSON.parse(readFileSync(process.env.DREVO_PAN_GRAPH!, "utf8")) as {
    people: { id: string; birth?: string }[];
    relations: { from: string; to: string; type: string }[];
  };
  const ids = new Map(graph.people.map((person, index) => [person.id, `pan-person-${index}`]));
  const people: Person[] = graph.people.map((person, index) => ({
    id: ids.get(person.id)!, name: `Человек ${index + 1}`, surname: "Тестов", patronymic: "",
    sex: "u", birth: person.birth || "", birthPlace: "", sources: [], generation: 1, column: 0,
    photo: `/media/pan-portrait-${index}.png`,
    parents: graph.relations.filter(r => r.type === "parent" && r.to === person.id)
      .flatMap(r => ids.has(r.from) ? [ids.get(r.from)!] : []),
    spouses: graph.relations.filter(r => r.type === "spouse" && (r.to === person.id || r.from === person.id))
      .flatMap(r => { const id = ids.get(r.to === person.id ? r.from : r.to); return id ? [id] : []; }),
  }));
  const portrait = await sharp({ create: { width: 64, height: 64, channels: 3, background: "#769475" } }).png().toBuffer();
  await page.route("**/media/pan-portrait-*", route => route.fulfill({ contentType: "image/png", body: portrait }));
  await page.route("**/api/family?projection=overview", async route => {
    const response = await route.fetch(), data = await response.json();
    data.family = { ...data.family, people, links: [], unions: [], photos: [] };
    data.partial = false;
    data.user.personId = null;
    data.treePreferences = { ...data.treePreferences, fragmentThreshold: 0, animateOnLoad: false };
    await route.fulfill({ response, json: data });
  });
  await page.goto("/tree");
  await expect(page.locator(".tree-canvas")).toHaveAttribute("data-layout-ready", "true", { timeout: 120_000 });
  await expect(page.locator(".tree-canvas")).not.toHaveClass(/is-growing|is-layout-settling/, { timeout: 30_000 });
  await page.waitForTimeout(1500);
  await profileTreeRenderer(page, info);
});
