import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createServer } from "vite";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { Family, Person } from "../src/domain/index.ts";

const root = new URL("..", import.meta.url);

test("mobile album keeps a compact title variant and hides the long hint", async () => {
  const server = await createServer({
    configFile: false,
    optimizeDeps: { noDiscovery: true },
    server: { middlewareMode: true, watch: null, hmr: false, ws: false },
    appType: "custom",
  });
  try {
    const { Gallery } = await server.ssrLoadModule("/src/components/gallery.tsx");
    const family: Family = {
      title: "Архив",
      description: "",
      people: [],
      photos: [],
      demo: false,
    };
    const html = renderToStaticMarkup(
      createElement(Gallery, {
        family,
        canEdit: false,
        onAdd: () => {},
        onOpen: () => {},
        onDropPhoto: () => {},
        onClearFilter: () => {},
      }),
    );
    assert.match(html, /gallery-title-mobile">Семейный альбом/);
    assert.match(html, /gallery-title-desktop">Лица нашей истории/);
  } finally {
    await server.close();
  }

  const css = readFileSync(new URL("src/styles/mobile-refinements.css", root), "utf8");
  assert.match(css, /\.gallery-photo-heading \.gallery-heading-copy > p/);
  assert.match(css, /\.gallery-title-desktop/);
  assert.match(css, /\.gallery-title-mobile/);
});

test("mobile kinship picker leaves only the two person slots", async () => {
  const server = await createServer({
    configFile: false,
    optimizeDeps: { noDiscovery: true },
    server: { middlewareMode: true, watch: null, hmr: false, ws: false },
    appType: "custom",
  });
  try {
    const { ComparisonPanel } = await server.ssrLoadModule(
      "/src/components/comparison-panel.tsx",
    );
    const person: Person = {
      id: "a",
      surname: "Иванов",
      name: "Иван",
      patronymic: "",
      sex: "m",
      birth: "",
      birthPlace: "",
      parents: [],
      spouses: [],
      sources: [],
      column: 0,
      generation: 1,
    };
    const html = renderToStaticMarkup(
      createElement(ComparisonPanel, {
        selected: [person],
        relation: null,
        people: [person],
        onRemove: () => {},
        onReveal: () => {},
      }),
    );
    assert.match(html, /comparison-content is-picking/);
    assert.match(html, /Выберите второго/);
  } finally {
    await server.close();
  }

  const css = readFileSync(new URL("src/styles/mobile-refinements.css", root), "utf8");
  assert.match(css, /comparison-content\.is-picking > :not\(\.comparison-people\)/);
  assert.match(css, /inspector-dock:has\(\.comparison-content\.is-picking\)/);
});

test("long press is touch-only, mobile-only and enters kinship selection", () => {
  const node = readFileSync(
    new URL("src/components/tree/person-node.tsx", root),
    "utf8",
  );
  const gesture = readFileSync(
    new URL("src/components/tree/use-long-press-compare.ts", root),
    "utf8",
  );
  const selection = readFileSync(
    new URL("src/hooks/useWorkspaceSelection.ts", root),
    "utf8",
  );
  assert.match(node, /useLongPressCompare\(\(\) => choose\(data\.person\.id, true\)\)/);
  assert.match(gesture, /event\.pointerType !== "touch"/);
  assert.match(gesture, /max-width: 899px/);
  assert.match(gesture, /}, 520\);/);
  assert.match(gesture, /> 12/);
  assert.match(node, /longPress\.suppressClick\.current/);
  assert.match(
    selection,
    /state\.selected\.includes\(action\.id\)[\s\S]*state\.compare[\s\S]*state\.selected/,
  );
});
