# Follow-up аудита Drevo — 11 сентября 2026

Этот документ продолжает `audit-2026-09-10.md` и фиксирует состояние `main` после серии проверок и исправлений 11 сентября. Старый аудит полезен как исходная точка, но часть его раздела «Оставшиеся задачи» уже не соответствует текущему коду.

## Что подтверждённо закрыто

| Область | Текущий статус |
| --- | --- |
| Полная запись архива при обычной правке | Закрыто PR #28. Обычные совместимые изменения SQLite применяются инкрементально; полный rewrite оставлен для reorder, restore/import и редких структурных конфликтов. |
| Отправка всего архива при обычном save | Закрыто PR #29. Клиент отправляет `Change[]` в `/api/family/changes`, revision/conflict flow сохранён. |
| Синхронная выдача `/media/*` | Закрыто PR #27. Оригиналы стримятся, preview работает по path/cache key. |
| Shared portrait через `media.read()` | Закрыто PR #31. Thumb строится по path, GIF/fallback отдаются через file stream. |
| Синхронная production static выдача | Закрыто PR #32–#33. Production static и hashed assets обслуживаются отдельными асинхронными handlers. |
| Крупный `tree-canvas.tsx` со смешанными обязанностями | Существенно декомпозирован PR #37–#40. Edge adapter, node model/layout orchestration, UI controls и camera state вынесены. `tree-canvas.tsx` уменьшился примерно с 34 КБ до 16,9 КБ. |
| Повторяющаяся same-origin проверка в выделенных HTTP handlers | Общий `isSameOriginRequest` добавлен PR #41; family changes, media upload, GEDCOM и shared-link mutations переведены на него PR #42. Старые копии внутри монолитного `index.ts` ещё остаются. |
| GEDCOM pre-import backup держит полную SQLite в Buffer | Закрыто PR #43. `VACUUM INTO` пишет backup сразу в конечный файл с правами `0600`. |
| Restore preview буферизует весь upload до 128 МБ в JS heap | Закрыто PR #44. Request stream сначала пишется в защищённый временный файл с лимитом, raw SQLite переименовывается без полной копии, gzip читается как stream. Старые restore E2E тесты проходят через новый ранний handler. |
| `/api/backup/full` создаёт полный SQLite Buffer | Закрыто PR #45. SQLite snapshot пишется сразу во временный staging-файл перед tar.gz. |
| `/api/backup` создаёт полный SQLite Buffer | Закрыто PR #46. Snapshot пишется во временный файл и отдаётся через stream; HTTP access test открывает полученный SQLite и проверяет `PRAGMA integrity_check`. |
| Retention deploy-релизов и автоматических backup | Уже реализован: сохраняются 5 последних deploy-релизов и 30 автоматических deploy-backup; `before-import-*` намеренно не удаляются этим retention. |

## Проверки и production

Runtime PR #39–#46 перед merge проходили GitHub Actions: `npm ci`, `npm run typecheck`, `npm run lint`, `bash -n ops/deploy.sh`, `npm run build`, все `tests/*.test.ts` на Node 22 и `npm run test:worker`.

После merge проверялись production workflow и health-check. Deploy #87–#94 завершились успешно, включая upload изолированного release, activation и `/api/health` после перезапуска.

Для backup/restore дополнительно фактически покрыты:

- права admin/reader/anonymous;
- SQLite `PRAGMA integrity_check` после HTTP download;
- полный tar.gz backup с SQLite и uploads;
- restore preview/apply и revision conflict;
- hostile TAR path, недопустимый тип/symlink и оборванные данные;
- восстановление портрета, gallery photo и tags;
- входной SQLite restore, разбитый на очень маленькие stream chunks.

## Что осталось

### P2 — мобильный CSS

`styles/tree-workspace.css` и `mobile-refinements.css` всё ещё содержат пересекающиеся правила для узкого экрана. Консолидацию нужно делать по одному компоненту и только вместе с реальной browser/mobile проверкой. Массовая перестановка `@media` без визуальной приёмки повышает риск регрессии сильнее, чем уменьшает технический долг.

### P2 — browser/mobile acceptance

Реальные Android/iOS жесты и геометрия интерфейса не проверялись браузером в этой серии работ. Нужно проверить как минимум:

- pan/pinch с началом на линии в обоих режимах дерева;
- swipe фотографий и tap для показа/скрытия отметок лиц;
- fullscreen дерева и хронологии;
- открытие, сворачивание, закрытие и прокрутку длинной карточки;
- смену ориентации и safe area;
- крупное дерево и фактический FPS/отзывчивость.

### P3 — версия схемы SQLite

`database.ts` создаёт baseline через `CREATE TABLE IF NOT EXISTS`, а отдельные изменения схемы определяет инспекцией таблиц и `ALTER TABLE`. Централизованного `PRAGMA user_version` и последовательного списка миграций пока нет. Это не текущий production-инцидент, но по мере роста схемы такой подход повышает риск неоднозначного состояния базы.

### P3 — `server/index.ts`

Центральный router остаётся крупным и содержит часть старых fallback-блоков, которые для GET media/static/restore/backup уже перехватываются ранними handlers. Там же остаются локальные копии same-origin проверки для маршрутов, ещё не вынесенных из монолита.

Удалять dead fallback и переносить оставшиеся маршруты лучше постепенно, вместе с декомпозицией router, а не полной заменой большого файла ради нескольких строк.

### P3 — остаточная память restore

PR #44 убрал максимальный 128-МБ request Buffer, но TAR parser пока собирает один распаковываемый файл в памяти перед записью. Лимит одного файла остаётся 32 МБ для SQLite и 20 МБ для media. При apply отдельные staged media также пока читаются целиком перед копированием.

Следующий безопасный шаг: потоково писать обычные TAR entries в staging и копировать staged media без полного Buffer, сохранив PAX/checksum/path/type проверки и rollback созданных файлов.

## Что сейчас не стоит делать

- Не добавлять виртуализацию каталога людей без измерений: текущая реализация уже выдаёт записи порциями.
- Не lazy-load панель родства ради размера chunk: предыдущая попытка показала, что сама панель мала, а основной вес принадлежит общему графовому стеку.
- Не переписывать `tree-canvas` дальше только ради числа строк: после декомпозиции оставшийся файл в основном выполняет роль orchestration layer.
- Не чистить CSS без browser/mobile regression check.
- Не удалять старые блоки из `index.ts` массовой полной заменой файла без безопасного patch/decomposition шага.

## Ограничение текущей приёмки

CI, HTTP integration и production health-check подтверждены. Ручная или browser-driven визуальная приёмка опубликованного интерфейса в этой серии работ не выполнялась. Поэтому утверждать, что мобильный UX визуально проверен, нельзя.
