# Доказательства аудита 9 октября 2026

Коммит: `2ca2e0a3eb86b4f2a1148b9d0bbf612da6de5126`.
Результаты и ограничения описаны в [отчёте](../../audit-2026-10-09.md).
JSON/JSONL сохранены в UTF-8, без персональных production-данных и секретов.

- `pool-probe.mjs`: настоящий StoreDatabase с подставным pool, **без подключения к БД**.
  Запуск из корня: `node --experimental-strip-types docs/benchmarks/audit-20261009/pool-probe.mjs`.
- `layout-probe.mjs`: холодный domain layout воспроизводимых синтетических семей;
  `node --experimental-strip-types docs/benchmarks/audit-20261009/layout-probe.mjs`.
  Ryzen 9 5950X, Windows, Node 22.14.0. Не браузерный/серверный load benchmark.
- `ai-ui-probe.mjs`: браузер с подставными AI status/SSE, проверка focus и renderer failure.
  Сначала собрать приложение и отдельно запустить `tests/e2e-server.ts` с временной БД.
  По умолчанию URL `http://127.0.0.1:4173/tree`; `DREVO_AUDIT_URL` меняет адрес,
  `PLAYWRIGHT_CHROMIUM_EXECUTABLE` задаёт installed Chrome при отсутствии Playwright browser.
  Запуск: `node docs/benchmarks/audit-20261009/ai-ui-probe.mjs`.
  **Использовать только локальный временный сервер, не production.**
- `web-vitals.jsonl`: по одному localhost запуску на 1440/390 px, шесть тестовых людей,
  без throttling и Nginx. INP не измерен; значения не являются полевыми Core Web Vitals.
- `code-inventory.json`: граф локальных TS/TSX runtime imports и размеры модулей;
  анализ не включает произвольные вычисляемые dynamic import или все зависимости npm.

Логи полных тестов и снимки UI оставлены локально в `E:\Codex\Temp`.
В отчёте сохранены исходные failed/skipped и отдельные повторные проверки;
они не заменены утверждением, что полный повторный набор прошёл.
