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

test("photo lightbox owns pinch zoom and keeps page zoom out of the gesture", () => {
  const gesture = readFileSync(
    new URL("src/components/use-photo-swipe.ts", root),
    "utf8",
  );
  const css = readFileSync(new URL("src/styles/mobile-refinements.css", root), "utf8");
  assert.match(gesture, /const MAX_ZOOM = 4/);
  assert.match(gesture, /touchPoints\(\)\.length >= 2/);
  assert.match(gesture, /Math\.hypot\(p2\.x - p1\.x, p2\.y - p1\.y\)/);
  assert.match(gesture, /panGesture\.current/);
  assert.match(gesture, /scale\.current > 1\.01/);
  assert.match(css, /\.photo-image-space\s*\{[\s\S]*touch-action: none/);
  assert.match(css, /\.photo-slide-current \.tag-image[\s\S]*will-change: transform/);
});

test("opened person portrait is larger on desktop and mobile", () => {
  const css = readFileSync(new URL("src/styles/mobile-refinements.css", root), "utf8");
  assert.match(
    css,
    /\.profile-avatar\s*\{\s*width: 144px;\s*height: 144px;/,
  );
  assert.match(
    css,
    /@media \(max-width: 899px\)[\s\S]*\.profile-avatar\s*\{\s*width: 128px;\s*height: 128px;/,
  );
});
