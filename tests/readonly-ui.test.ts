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
    const { InspectorDock } = await server.ssrLoadModule(
      "/src/components/inspector-dock.tsx",
    );
    const dock = renderToStaticMarkup(
      createElement(InspectorDock, { onClose: () => {} }, "Профиль"),
    );
    assert.match(dock, /class="inspector-dock expanded"/);
    assert.match(dock, /aria-expanded="true"/);
    assert.match(dock, /Свернуть панель/);
    const choosingPair = renderToStaticMarkup(
      createElement(
        InspectorDock,
        { onClose: () => {}, initialExpanded: false },
        "Выберите второго человека",
      ),
    );
    assert.match(choosingPair, /aria-expanded="false"/);
    assert.match(choosingPair, /Развернуть панель/);
    const { ConnectionInspector } = await server.ssrLoadModule(
      "/src/components/connection-inspector.tsx",
    );
    const { AboutProject } = await server.ssrLoadModule(
      "/src/components/about-project.tsx",
    );
    const { PhotoViewer } = await server.ssrLoadModule(
      "/src/components/photo-viewer.tsx",
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
      }),
    );
    assert.match(inspector, /Фотоальбом/);
    assert.doesNotMatch(
      inspector,
      /Изменить|Редактировать|Новый человек|Уже в древе|Можно уточнить/,
    );
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
    const { PersonHints } = await server.ssrLoadModule(
      "/src/components/person-hints.tsx",
    );
    const hintsFamily: Family = {
      ...family,
      people: [p, { ...family.people[1], surname: "Петрова" }],
    };
    const hints = renderToStaticMarkup(
      createElement(PersonHints, {
        person: hintsFamily.people[1],
        family: hintsFamily,
        user,
        busy: false,
        save: async () => hintsFamily,
        onConnection: noop,
      }),
    );
    assert.match(hints, /Да, указать Иванова/);
    const outsiderHints = renderToStaticMarkup(
      createElement(PersonHints, {
        person: hintsFamily.people[1],
        family: hintsFamily,
        user: { ...user, id: "other", role: "relative" },
        busy: false,
        save: async () => hintsFamily,
        onConnection: noop,
      }),
    );
    assert.equal(outsiderHints, "");
    const photo = {
      id: "photo",
      url: "/media/example.jpg",
      title: "Семейный снимок",
      tags: [
        { id: "tag", personId: p.id, x: 0.1, y: 0.1, width: 0.2, height: 0.3 },
      ],
    };
    const viewer = renderToStaticMarkup(
      createElement(PhotoViewer, {
        photo,
        photos: [photo, { ...photo, id: "next" }],
        onNavigate: noop,
        family,
        canEdit: false,
        canDelete: false,
        busy: false,
        save: async () => family,
        onClose: noop,
        onPerson: noop,
      }),
    );
    assert.match(viewer, /Открыть карточку: Иванов Иван/);
    assert.match(viewer, /class="photo-lightbox"/);
    assert.doesNotMatch(viewer, /<h2>Фотография/);
    assert.match(
      viewer,
      /<footer class="photo-footer">[\s\S]*href="\/media\/example.jpg" download=""[\s\S]*<\/footer>/,
    );
    const previousButton = viewer.match(
      /<button[^>]*aria-label="Предыдущая фотография"[^>]*>/,
    )![0];
    const nextButton = viewer.match(
      /<button[^>]*aria-label="Следующая фотография"[^>]*>/,
    )![0];
    assert.match(previousButton, /disabled/);
    assert.doesNotMatch(nextButton, /disabled/);
    assert.doesNotMatch(
      viewer,
      /Найти лица|Добавить человека в древо|Убрать отметку|<form/,
    );
    const editing = renderToStaticMarkup(
      createElement(PhotoViewer, {
        photo,
        photos: [photo, { ...photo, id: "next" }],
        family,
        canEdit: true,
        initialEditing: true,
        canDelete: true,
        busy: false,
        save: async () => family,
        onClose: noop,
        onPerson: noop,
        onNavigate: noop,
      }),
    );
    assert.match(
      editing.match(/<button[^>]*aria-label="Следующая фотография"[^>]*>/)![0],
      /disabled/,
      "navigation cannot discard an active editor",
    );
    assert.match(editing, /Найти лица/);
    const { PersonPhotoAlbum } = await server.ssrLoadModule(
      "/src/components/person-photo-album.tsx",
    );
    const stack = renderToStaticMarkup(
      createElement(PersonPhotoAlbum, {
        photos: Array.from({ length: 10 }, (_, i) => ({
          ...photo,
          id: String(i),
          url: `/media/photo-${i}.jpg`,
        })),
        onOpen: noop,
      }),
    );
    assert.equal(
      (stack.match(/<img /g) || []).length,
      3,
      "profile loads just three album covers",
    );
    assert.match(stack, /10 фото/);
  } finally {
    await server.close();
    rmSync(cacheDir, { recursive: true, force: true });
  }
});
