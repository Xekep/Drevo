# Доказательства UI аудита Drevo

Снимок исходников: `1899756196b1ef7278db96c6aa829ce237b8fd0d`, 10 октября 2026. [Отчёт](../../ui-audit-2026-10-10.md). Все данные локальные и синтетические.

## Содержимое

- `validation.json`: 74 состояния, размеры видимых controls, переполнение страницы, результаты двух групп E2E.
- `details.json`: resize, утрата черновика, focus и доступное меню за мобильной панелью, статус загрузки тестового PDF.
- `focus.json`: геометрия focused input и hit-test подтверждают полное перекрытие sticky footer.
- `reader.json`: двухстраничный режим и ширина страницы PDF на touch viewport 390×844.
- `zoom.json`: вычисленные CSS-размеры и экранный размер текста с учётом transform.
- `ai-focus-mobile.json`: переход фокуса в фон при открытом ИИ.
- `photos.json`: результаты просмотра синтетической фотографии.
- `lighthouse-editor.json`: оценки одного snapshot редактора и подробности двух ошибок контраста. UTC-время в файле соответствует 10 октября по Europe/Moscow.
- 12 PNG: выбранные иллюстрации проблем и контрольных состояний. Файлы touch-эмуляции имеют больший размер в физических пикселях из-за deviceScaleFactor; выводы относятся к CSS px.

Скрипт оценки контраста в `capture-screens.cjs` предназначен для предварительного отбора: он не учитывает фоновые картинки, градиенты и все варианты смешивания. Его результаты на таких поверхностях не доказывают нарушение. Для редактора ошибки отдельно подтверждены Lighthouse; для плоских счётчиков указаны фактические CSS-пары.

## Повторить browser probes

Запускать из корня репозитория после установки зависимостей. Нужен отдельный `tests/e2e-server.ts`: `reproduce-interactions.cjs` загружает синтетический PDF. Loopback-проверка в скриптах не различает production и fixture, поэтому нельзя подставлять локальный туннель к реальной базе.

В первом PowerShell:

```powershell
npm run build
$env:DREVO_E2E_PORT = '4191'
node --experimental-strip-types tests/e2e-server.ts
```

Этот сервер создаёт временную SQLite-базу с тестовыми людьми и удаляет её при штатной остановке. Production build нужен, потому что E2E-сервер отдаёт `dist`. При изменении исходников перед повторной проверкой снова собрать build.

Во втором PowerShell из того же корня:

```powershell
$env:UI_AUDIT_URL = 'http://127.0.0.1:4191'
$env:UI_AUDIT_OUTPUT = Join-Path $env:TEMP 'drevo-ui-audit-replay'
$env:PLAYWRIGHT_CHROMIUM_EXECUTABLE = 'C:/Program Files/Google/Chrome/Application/chrome.exe'
node docs/benchmarks/ui-audit-20261010/capture-screens.cjs
node docs/benchmarks/ui-audit-20261010/reproduce-interactions.cjs
node docs/benchmarks/ui-audit-20261010/reproduce-mobile-editor-reader.cjs
node docs/benchmarks/ui-audit-20261010/measure-tree-zoom.cjs
node docs/benchmarks/ui-audit-20261010/capture-photo.cjs
node docs/benchmarks/ui-audit-20261010/reproduce-ai-focus.cjs
```

Последовательность имеет значение: `reproduce-interactions` создаёт PDF, следующий скрипт открывает первый документ. Каждый повтор этого скрипта добавляет один тестовый документ; новую серию лучше начинать с нового disposable сервера. AI/account/admin responses подменяются только на уровне браузера. Это диагностические скрипты, а не новые assertions, закрывающие регрессии.

## E2E проверки

Сборка: `npm run build` — прошла. Группа 1 — 35 passed, 9 skipped, 58,2 с; группа 2 — 25 passed, 11 skipped, около 1,1 минуты. Итого 60 passed, 20 skipped. Пропуски не считались успешными проверками.

Для каждого запуска нужен свободный порт; Playwright поднимает и останавливает собственный временный сервер, `reuseExistingServer=false`.

```powershell
$env:PLAYWRIGHT_CHROMIUM_EXECUTABLE = 'C:/Program Files/Google/Chrome/Application/chrome.exe'
$env:DREVO_E2E_PORT = '4192'
npx playwright test tests/e2e/admin-layout.spec.ts tests/e2e/ai-role-profiles.spec.ts tests/e2e/person-editor-sections.spec.ts tests/e2e/research-graph.spec.ts tests/e2e/mobile-tree-zoom.spec.ts tests/e2e/horizontal-timeline.spec.ts --workers=2 --reporter=line
$env:DREVO_E2E_PORT = '4193'
npx playwright test tests/e2e/tree-view-motion.spec.ts tests/e2e/tree-growth-visual.spec.ts tests/e2e/tree-branch-fold.spec.ts tests/e2e/tree-transition-continuity.spec.ts --workers=2 --reporter=line
```

Анимационные E2E идут с `reducedMotion=no-preference`; статические browser captures преимущественно используют `reduce`. Физические устройства, screen readers и сторонние браузеры в эту серию не входят.
