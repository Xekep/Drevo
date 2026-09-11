# Итоговый follow-up аудит Drevo — 11 сентября 2026

Документ закрывает технический аудит, начатый в `audit-2026-09-10.md`. Контрольная кодовая версия перед этим docs-only изменением — `53e9cc849a5b0635d432c3bdf8ed07a18c12bde2`.

## Закрыто

| Область | Результат |
| --- | --- |
| Production schema v2 | Deploy run `34610028445` для `827b70c3` завершён `success`; `Upload isolated release` и `Activate and check release` успешны. |
| Владелец SQLite-схемы | PR #62 удалил DDL из store-модулей. Основная схема создаётся только в `src/server/schema.ts`; source-тест запрещает `CREATE TABLE` и `CREATE INDEX` в остальных `src/server/*.ts`. |
| Порядок инициализации | `openArchive()` синхронно вызывает `initializeArchiveSchema()` до создания stores и runtime cleanup. Seed настроек и marker удаления demo-данных остались runtime data logic. |
| Миграции | Существуют последовательные v0→v1→v2 шаги. Каждый шаг выполняется в `BEGIN IMMEDIATE`; `user_version` меняется перед `COMMIT` только после успешного шага. Проверены legacy schema, v1→v2 с сохранением данных, отказ от future version и rollback частично выполненного DDL. |
| Server routing | PR #63 удалил второй production static fallback и закрепил единый порядок handler chain. PR #67 вынес публичный shared HTTP; `src/server/index.ts` содержит 190 строк сборки и верхнего dispatch, `sharing-http.ts` — около 100 строк композиции handlers. |
| Полотно дерева | Ранее выделены `tree-edge-adapter.ts`, node model, camera state/tools и UI-контролы. Текущий `tree-canvas.tsx` — 537 строк orchestration и interaction logic; повторное механическое дробление без нового устойчивого boundary не требуется. |
| CSS дерева | PR #64 свёл соседние mobile media blocks и удалил точный дубль. Сравнение итоговой cascade map до/после показало одинаковые 938 selector/property declarations; число блоков `max-width: 899px` уменьшилось с 6 до 4. |
| Media I/O | Upload и отдача оригиналов потоковые. PR #65 удалил неиспользуемые `mediaStore.add(Buffer)` и `mediaStore.read()` вместе с синхронным whole-file I/O; source-тест запрещает его возвращение. |
| Backup I/O | HTTP backup создаёт SQLite snapshot во временном файле и стримит его. PR #68 удалил production helper, возвращавший всю SQLite в `Buffer`; byte-helper оставлен только в тестах upload/restore. |
| Restore I/O | Upload и TAR entries пишутся прямо в staging. PR #69 заменил `copyFileSync` при apply на асинхронное exclusive-копирование media и сохранил rollback уже созданных файлов. |
| Restore security | Сохранены лимиты upload 128 МБ, SQLite 32 МБ, media 20 МБ, unpacked 512 МБ и 10 000 entries; checksum TAR, запрет ссылок, whitelist путей, duplicate names, magic/extension, read-only SQLite validation, staging cleanup, revision conflict и media rollback. |

## Слитые PR этой серии

- #62 — единый владелец SQLite DDL;
- #63 — единый production static handler;
- #64 — безопасная консолидация mobile CSS;
- #65 — удаление мёртвого буферного media API;
- #66 — regression-тест rollback миграции;
- #67 — выделение public shared HTTP;
- #68 — удаление буферного backup API из runtime;
- #69 — асинхронное копирование restore media.

Незелёный старый PR #52 закрыт и заменён PR #67 от актуального `main` с исправленным source-regression тестом.

## Автоматически проверено

Каждый кодовый PR прошёл Linux CI:

- `npm run typecheck`;
- `npm run lint`;
- `bash -n ops/deploy.sh`;
- `npm run build`;
- каждый `tests/*.test.ts` через Node 22 strip-types;
- `npm run test:worker`.

После каждого merge production workflow успешно выполнил isolated upload и activation/health check. Проверены runs `34610969398`, `34611667323`, `34612247061`, `34613065388`, `34613576622`, `34614128797`, `34614685388` и `34615203182`.

Restore интеграционные тесты проверяют read-only preview, обязательное подтверждение, revision conflict, backup текущей базы, сохранение настроек доступа, полный архив с media/tags, неперезапись существующих файлов, hostile path, symlink, oversized entry, truncated input и SQLite upload, разбитый на маленькие chunks.

## Остаётся

- Дополнительную консолидацию правил между `tree-workspace.css` и `mobile-refinements.css` делать по конкретному компоненту вместе с реальной browser/device проверкой. Массовая перестановка правил не имеет доказанной выгоды.
- Синхронная SQLite API остаётся фундаментом server store. Короткие чтения magic header и startup-чтение seed ограничены; TAR parser использует прямую запись chunks в staging без накопления entries в памяти. Его перевод на полностью асинхронную state machine потребует отдельной security-рецензии и сейчас не оправдан.

## Сознательно не делалось

- `ComparisonPanel` повторно не выносился: прежний эксперимент дал mobile regression и не исключил основной shared graph bundle из eager path.
- Lazy chunk `face-api` не оптимизировался только из-за размера: он загружается по требованию и не входит в начальный экран.
- `tree-canvas.tsx` не переписывался ради числа строк: edge adapter, camera state и controls уже выделены, а оставшийся код связан жизненным циклом React Flow и жестами.
- Restore parser и migration history v1/v2 не переписывались. Опубликованные migration steps являются воспроизводимой историей production баз.

## Требует browser/device acceptance

В этой серии выполнены source-проверки, HTTP integration, CI и production health check. Ручная визуальная приёмка в реальном браузере, Android и iOS не выполнялась. Отдельно следует проверить:

- pan/pinch/double tap с началом жеста на node и edge;
- открытие, прокрутку и swipe-close карточки;
- fullscreen дерева и хронологии;
- photo viewer, swipe и hover/tap подписей;
- карту мест, список мест и safe areas;
- большое реальное дерево: читаемость, пересечения и FPS.

## Проверка docs-only deploy filter

Этот документ меняется отдельным docs-only PR. После его squash merge для итогового SHA не должен появиться run workflow `Deploy Drevo`, поскольку `.github/workflows/deploy.yml` исключает `docs/**` и `**/*.md`. Результат acceptance фиксируется в PR и итоговом отчёте аудита.
