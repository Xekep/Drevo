<p align="center"><img src="public/logo.svg" width="320" alt="Древо"></p>

# Древо

Веб-приложение для семейного архива: генеалогическое древо, люди и семьи,
фотографии, документы и история родственников.

React · TypeScript · Vite · Node.js · PostgreSQL / SQLite.

## Быстрый запуск

Нужен **Node.js 26.13.0 LTS** — версия закреплена в [.nvmrc](.nvmrc).

```sh
npm ci
npm run dev
```

Откройте [127.0.0.1:3000](http://127.0.0.1:3000).
При локальном запуске вход не требуется. Данные сохраняются в `data/`;
при первом запуске создаётся пустой архив.

## Команды

| Команда | Назначение |
| --- | --- |
| `npm run dev` | Запуск для разработки |
| `npm run typecheck` | Проверка типов |
| `npm run lint` | Проверка кода |
| `npm test` | Unit- и API-тесты |
| `npm run build` | Сборка интерфейса в `dist/` |
| `npm run test:worker` | Проверка собранного Worker после сборки |
| `npm run test:e2e` | Браузерные тесты Playwright |
| `npm start` | Запуск готовой сборки |

Браузерные тесты требуют Chromium: `npx playwright install chromium`.

## Где что находится

| Каталог | Содержимое |
| --- | --- |
| `src/` | Код приложения и импортируемые ресурсы |
| `tests/` | Тесты; отчёты — в игнорируемом `.artifacts/` |
| `docs/` | Документация |
| `public/` | Ресурсы с постоянными URL |
| `ops/` | Деплой, бэкапы и обслуживание сервера |

Конфиги инструментов находятся в корне. `node_modules/`, `dist/` и `data/`
создаются локально и не хранятся в Git.

## Документация

[Указатель: для инженера и для агента](docs/README.md).

- [Как вести архив](docs/engineering/usage.md)
- [Архитектура и разработка](docs/engineering/architecture.md)
- [API](docs/engineering/api.md)
- [Установка на сервер](docs/engineering/deployment.md) и [пример окружения](.env.example)
- [Бэкапы и восстановление](docs/engineering/backup.md)
- [Переход сервера на Node.js 26](docs/engineering/node-26-migration.md)
