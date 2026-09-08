import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "vite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { ArchiveUser, Family, Person } from "../src/domain/index.ts";

test("reader UI keeps stories, albums and navigation while removing editor controls even for an admin", async () => {
  const cacheDir = mkdtempSync(join(tmpdir(), "drevo-ui-"));
  const server = await createServer({
    configFile: false,
    cacheDir,
    optimizeDeps: { noDiscovery: true },
    server: { middlewareMode: true, watch: null, hmr: false, ws: false },
    appType: "custom",
  });
  try {
    const { ArchiveNavigation } = await server.ssrLoadModule(
      "/src/components/archive-navigation.tsx",
    );
    const { PersonInspector } = await server.ssrLoadModule(
      "/src/components/person-inspector.tsx",
    );
    const { ConnectionInspector } = await server.ssrLoadModule(
      "/src/components/connection-inspector.tsx",
    );
    const { AboutProject } = await server.ssrLoadModule(
      "/src/components/about-project.tsx",
    );
    const user = {
      id: "admin",
      role: "admin",
      name: "Администратор",
    } as ArchiveUser;
    const p: Person = {
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
    const family: Family = {
      title: "Архив",
      description: "",
      people: [p, { ...p, id: "b", name: "Анна", sex: "f", parents: [p.id] }],
      photos: [],
      demo: false,
    };
    const noop = () => {};
    const navigation = renderToStaticMarkup(
      createElement(ArchiveNavigation, {
        desktop: false,
        view: "tree",
        onView: noop,
        user,
        local: false,
        readTree: true,
        readPhotos: true,
        onHelp: noop,
      }),
    );
    assert.match(navigation, /О проекте/);
    assert.match(navigation, /Семьи/);
    assert.match(navigation, /Фото/);
    assert.doesNotMatch(navigation, /Админка|Админская панель/);
    const inspector = renderToStaticMarkup(
      createElement(PersonInspector, {
        person: p,
        family,
        user,
        canEdit: false,
        readPhotos: true,
        onSelect: noop,
        onCompare: noop,
        onEdit: noop,
        onNewRelative: noop,
        onExistingRelative: noop,
        onAlbum: noop,
        onPhoto: noop,
      }),
    );
    assert.match(inspector, /Фотоальбом/);
    assert.doesNotMatch(inspector, /Редактировать|Новый человек|Уже в древе/);
    const connection = renderToStaticMarkup(
      createElement(ConnectionInspector, {
        family,
        user,
        canEdit: false,
        draft: { from: "a", to: "b", type: "parent" },
        onChange: noop,
        save: async () => family,
        busy: false,
        onClose: noop,
      }),
    );
    assert.match(connection, /отец/);
    assert.doesNotMatch(
      connection,
      /<form|<select|Сохранить связь|Убрать связь/,
    );
    const about = renderToStaticMarkup(
      createElement(AboutProject, { onClose: noop }),
    );
    assert.match(about, /История начинается/);
    assert.match(about, /Перейти к истории/);
  } finally {
    await server.close();
    rmSync(cacheDir, { recursive: true, force: true });
  }
});
