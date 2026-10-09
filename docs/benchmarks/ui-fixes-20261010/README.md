# Доказательства после UI исправлений

[Отчёт исправлений](../../ui-audit-fixes-2026-10-10.md), 10 октября 2026.
Данные синтетические, сервер `tests/e2e-server.ts` с временной базой,
production `dist`, Chrome desktop и эмуляция Pixel 5. Деплой не выполнялся.

## Содержимое

- `validation.json`: проверки, число состояний, переполнение, ошибки и история E2E.
- `ai-320.png`, `ai-1440.png`: пропорции направленной схемы и размеры действий.
- `tree-1440.png`, `tree-390.png`: новая согласованная типографика ФИО и инструменты.
- `editor-390.png`, `focus-hidden-390.png`, `focus.json`: исходное имя probe сохранено,
  но после исправления поле находится выше панели сохранения и hit-test успешен.
- `reader-touch-390.png`, `reader.json`: одна страница, ширина около 356 CSS px.
- `admin-ai-390.png`: оформленный выбор архива.
- `details.json`: сохранённый черновик, доступное меню за complementary профилем,
  видимые карточки после resize и статус тестового PDF.
- `zoom.json`: постоянные 22 px базового ФИО, экранный размер меняется вместе с зумом.
- `lighthouse-editor.json`: сокращённый результат snapshot. Не является сертификатом WCAG.

Снимки не включают реальные пользовательские фотографии. Ответы ИИ подменены
браузерным route: это проверка вывода и взаимодействий, не качества Yandex-модели.

## Повторение

Команды browser probes находятся в [доказательствах исходного аудита](../ui-audit-20261010/README.md).
Перед повторением пересобрать `dist`, запустить новый disposable сервер и задать
отдельную папку `UI_AUDIT_OUTPUT`. PDF probe создаёт тестовый документ; не запускать
его на production или на localhost-туннеле к рабочей базе.

Из корня репозитория:

```powershell
npm run typecheck
npm run lint
npm test
npm run build
npm run test:worker
$env:PLAYWRIGHT_CHROMIUM_EXECUTABLE = 'C:/Program Files/Google/Chrome/Application/chrome.exe'
$env:DREVO_E2E_PORT = '4200'
npx playwright test tests/e2e/ui-audit-regressions.spec.ts tests/e2e/research-graph.spec.ts --workers=1 --reporter=line
```

Основной прогон включал admin-layout, ai-role-profiles, person-editor-sections,
research-graph, mobile-tree-zoom, horizontal-timeline, tree-view-motion,
tree-growth-visual, tree-branch-fold, tree-transition-continuity, tree-scope-camera,
research-chat-selection, research-attachments и ui-audit-regressions.

Не запускать несколько Playwright-процессов с одной папкой `test-results`:
один процесс удаляет артефакты другого. Разные порты не защищают общую папку;
использовать последовательные запуски или разный `--output`.
