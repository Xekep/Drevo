# Установка сервера и деплой

Основной домен: `mydrevo.org`; `drevo.kiiko.ru` постоянно перенаправляет на него с сохранением пути и параметров. Хост: `94.232.248.210`, SSH-порт `4321`, пользователь доставки `deploy`. Ключ — GitHub repository secret **`DEPLOY_SSH_KEY`**. Закрытый ключ и секрет OAuth в репозиторий не добавляются.

## Каталоги и процесс

Для запуска с `--production` или `NODE_ENV=production` обязателен `PUBLIC_ORIGIN=https://mydrevo.org` без завершающего слеша и пути. При отсутствии или неверном адресе процесс останавливается до открытия рабочей базы. Это исключает случайное включение локального администратора на опубликованном сервере. В `ops/drevo.service` адрес уже задан.

Регистрация по почте включается только при `EMAIL_AUTH_ENABLED=1`, PostgreSQL и заполненных `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASSWORD`, `SMTP_FROM` в `/etc/drevo.env`. Для порта 587 обязательно STARTTLS, для 465 — TLS сразу; ошибки сертификата не игнорируются. Проверьте доставку подтверждения и восстановления на тестовом окружении с этим флагом и тестовым адресом, затем включите флаг в production. До этого кнопка почты скрыта, а API возвращает 503. Не записывайте ссылки и пароли в журналы. Подтверждение создаёт отдельный приватный архив с базовым уровнем; совпадение почты с OAuth не объединяет аккаунты автоматически.

Существующий OAuth-аккаунт подключает почту в личном кабинете после повторного входа через Яндекс или VK. Запрос и подтверждение ссылки требуют OAuth-сеанса не старше 10 минут; старые сеансы продолжают работать для обычного просмотра, но не для смены способа входа.

На новом production-сервере также задайте `INITIAL_ADMIN_YANDEX_ID`. Пока в базе нет администратора, отсутствие этой переменной останавливает запуск. На уже настроенном сервере с существующим администратором переменная не обязательна.

`ops/nginx.conf` содержит отдельный лимит 12 ГиБ и тайм-аут 120 секунд для `/api/restore/preview`; импорт GEDZIP допускает до 512 МиБ и имеет тайм-аут 900 секунд. Остальные загрузки ограничены 21 МБ. Для скачивания GEDZIP предусмотрены 900 секунд и отключено буферизование; для управляемых копий `/api/backups/*`, офлайн-архива `/api/offline/export` и применения восстановления `/api/restore/apply` — 1800 секунд. Изменения Nginx не устанавливаются workflow автоматически: конфигурацию сайта нужно применить отдельно с `nginx -t` и reload. Сервер приложения дополнительно ограничивает распаковку бэкапа и размер SQLite.

PDF-ридер рисует страницы через PDF.js и показывает их как локальные `blob:`-изображения. В CSP сайта `img-src` должен разрешать `blob:`; разрешения `worker-src` для этого недостаточно. Браузерные тесты документов используют CSP из `ops/nginx.conf` и проверяют загрузку изображения, размеры страниц, листание и удаление, а не только счётчик страниц. Удаление доступно автору с правом редактирования или администратору, проверяет область доступа и Origin, записывается в журнал и удаляет привязки вместе с каталоговой записью. Файл удаляется после транзакции; ошибка очистки диска логируется, повторный доступ к удалённому документу уже закрыт. Существующие резервные копии сохраняют документ до истечения своего срока хранения.

Для карты серверу нужен исходящий HTTPS к Photon и Wikidata, браузеру — к `tile.openstreetmap.org`. Координаты и кэш сохраняются в выбранной рабочей БД. Адреса геопоиска можно сменить через `GEOCODER_URL` и `HISTORICAL_GEOCODER_URL` в окружении сервиса. [Поиск, ограничения и провайдеры](places.md).

```text
/var/www/drevo.kiiko.ru/
  releases/<идентификатор>/   # dist, src/server, src/domain, public/data, ops
  current -> releases/...    # Активный релиз
  shared/
    drevo.sqlite             # SQLite-режим; после перехода — сохранённый исходник
    drevo.sqlite.secrets.key # Ключ шифрования настроек, нужен и PostgreSQL
    postgres.active          # Защита от случайного возврата к SQLite
    uploads/                 # Постоянные изображения
    previews/                # Восстанавливаемый кэш WebP, не входит в бэкап
    backups/                 # Переносимые бэкапы, pg_dump и прежние SQLite-копии
    backup-ssh/              # SSH config, ключ и known_hosts отдельного хранилища
```

Процесс systemd `drevo.service` работает от `site_drevo:site_drevo_grp`, слушает `127.0.0.1:3107`, использует Node.js из `/opt/drevo-node`. Nginx принимает HTTPS и проксирует запросы. Каталог `shared` сохраняется между обновлениями. Для существующей базы демонстрационные данные повторно не загружаются.

## Подготовка нового сервера

1. Проверьте DNS, Nginx, Certbot, Python 3, ACL, пользователя `deploy` и его ключ.
2. Запустите от root `ops/setup-server.sh`. Сценарий создаёт пользователя/каталоги, ставит Node.js 22.23.2 с проверкой SHA256 и разрешает `deploy` только точечный перезапуск сервиса через sudo.
3. Установите `ops/drevo.service` в `/etc/systemd/system/drevo.service`; выполните `systemctl daemon-reload`.
4. Создайте `/etc/drevo.env` с режимом `600`, владельцем root. Пример ниже содержит только названия параметров.
5. Для первого сертификата используйте `ops/nginx-http.conf`, включите сайт, выполните `nginx -t`, перезагрузите Nginx и получите сертификат: `certbot certonly --webroot -w /var/www/letsencrypt -d mydrevo.org`. Для редиректа со старого HTTPS-адреса также сохраните действующий сертификат `drevo.kiiko.ru` и его продление.
6. Замените временный конфиг на `ops/nginx.conf`, проверьте `nginx -t`, перезагрузите Nginx. В конфигурации два HTTPS virtual host: приложение на новом домене и редирект со старого. Для существующей установки оставьте каталог `/var/www/drevo.kiiko.ru` как внутренний путь к базе, фотографиям и релизам.
7. Установите `ops/drevo-backup.service` и `ops/drevo-backup.timer`, включите таймер: `systemctl enable --now drevo-backup.timer`. После первого запуска приложения задайте период, количество и хранилище в **Админка → Резервные копии**. Для отдельного сервера подготовьте SSH-профиль по [инструкции](backup.md). При обновлении существующей установки также обновите units: старый `BACKUP_REMOTE` больше не используется.
8. Выполните первый деплой, включите автозапуск `systemctl enable drevo`.

```ini
YANDEX_CLIENT_ID=<идентификатор приложения>
YANDEX_CLIENT_SECRET=<секрет приложения>
INITIAL_ADMIN_YANDEX_ID=<постоянный id владельца из профиля Яндекс OAuth>
ARCHIVE_PRIVATE=1

# Необязательно: встроенный ИИ-исследователь
YANDEX_AI_API_KEY=<API-ключ AI Studio>
YANDEX_AI_FOLDER_ID=<идентификатор каталога>
YANDEX_AI_MODEL=yandexgpt/rc
```

`ARCHIVE_PRIVATE=1` или отсутствие переменной задаёт закрытый просмотр при первом создании настроек; только явное `0` — открытый. Затем доступ к древу и альбомам независимо задаётся в «Управлении архивом» и хранится в рабочей БД. Вход — через Яндекс или [VK ID](vk-oauth.md): пользователь с `INITIAL_ADMIN_YANDEX_ID` получает первого администратора, остальные новые пользователи — читателей. Администратор назначает роли; родственник редактирует только свои записи. Бэкапы доступны администратору. После смены `/etc/drevo.env` перезапустите `drevo.service`. Если переменные `YANDEX_AI_*` не заданы, ИИ-панель скрыта и остальной архив работает как раньше.

Настройки сервера сохранены локально вне Git: `C:\Users\Xekep\Desktop\web\drevo.env`. Храните их резервную копию отдельно. Callback Яндекса: `https://mydrevo.org/auth/yandex/callback`; подробности в [инструкции OAuth](yandex-oauth.md).

## GitHub Actions

`.github/workflows/ci.yml` выполняет проверки для pull request в `main`: `npm ci`, аудит production-зависимостей, TypeScript, ESLint, сборку, все тестовые файлы, проверку собранного Worker и Chromium smoke-тест production bundle на desktop/mobile viewport. Это позволяет увидеть красный набор проверок до merge, а не уже во время выкладки.

Файл `.github/workflows/deploy.yml` запускается при push в `main` и вручную через **Actions → Deploy Drevo → Run workflow**. Ручная выкладка допускается только с `main`; job привязан к GitHub Environment `production`. Он повторяет проверки перед выкладкой. В отдельный каталог релиза устанавливаются серверные зависимости из `ops/runtime/package-lock.json`: Sharp с готовыми библиотеками для Linux. Этот небольшой `node_modules` входит в релиз; зависимости разработки, локальная база, фотографии и секреты не отправляются. При обновлении Sharp синхронно обновляйте основной и серверный манифесты с lock-файлами.

SSH проверяет закреплённый публичный ключ сервера из существующей локальной конфигурации. При реальной смене серверного ключа обновите `known_hosts` в workflow после проверки нового отпечатка.

Каждый запуск загружает отдельный каталог `<commit>-<попытка>`. `ops/deploy.sh` блокирует параллельную активацию, сохраняет выбранную БД (SQLite либо нативный PostgreSQL dump) и запускает новый и предыдущий релизы на изолированной копии базы. Несовместимость миграции останавливает деплой до изменения рабочей БД. После проверки скрипт атомарно переключает `current`, перезапускает процесс и проверяет `/api/health`. При неудаче возвращает предыдущий код и завершает workflow с ошибкой. Пользовательская база не перезаписывается файлами релиза. Намеренно несовместимые миграции требуют отдельного плана обслуживания и восстановления.

После успешного health-check автоматически сохраняются 5 последних deploy-релизов и 30 последних копий БД (`.sqlite` или `.pgdump`), созданных именно деплоем. Ручные и `before-import-*` бэкапы этот cleanup не удаляет.

### PostgreSQL

После установки 058 для версии 059 выполните `ops/postgres/059_deleted_account_annotation_authors.sql`
от имени PostgreSQL-владельца функций удаления аккаунта **до** активации нового приложения.
Роль приложения не может заменить функцию `SECURITY DEFINER`; пока она не установлена,
удаление аккаунта отвечает конфликтом до изменения данных. Сверьте точный SQL из PR и
поместите его во временный файл с владельцем `root` вне каталога релиза, доступного для
записи при деплое. Сначала проверьте скрипт на отдельной копии БД, затем примените к рабочей.
Не вызывайте HTTP-удаление аккаунта для проверки.

```bash
set -euo pipefail
db=$(cat /var/www/drevo.kiiko.ru/shared/postgres.active)
[[ "$db" =~ ^[a-zA-Z_][a-zA-Z0-9_]*$ ]] || exit 1
sql=/root/059_deleted_account_annotation_authors.sql
test "$(stat -c '%U:%a' "$sql")" = root:600
preflight_db=drevo_annotation_059_preflight
sudo -u postgres createdb "$preflight_db"
sudo -u postgres pg_dump -Fc "$db" |
  sudo -u postgres pg_restore --no-owner --exit-on-error -d "$preflight_db"
cat "$sql" | sudo -u postgres psql -X -v ON_ERROR_STOP=1 -d "$preflight_db"
cat "$sql" | sudo -u postgres psql -X -v ON_ERROR_STOP=1 -d "$preflight_db"
sudo -u postgres dropdb "$preflight_db"
cat "$sql" | sudo -u postgres psql -X -v ON_ERROR_STOP=1 -d "$db"
```

Проверьте, что `installed`, `security_definer`, `privileged_owner` и `entrypoint_calls`
равны `t`, `app_helper_execute` равен `f`, а `remaining_deleted_authors` равен `0`.
`ambiguous_reused_ids` показывает ID с маркером удаления, которые уже заняты действующим
аккаунтом: миграция оставляет эти аннотации для отдельной проверки.

```bash
sudo -u postgres psql -X -v ON_ERROR_STOP=1 -d "$db" -c "
SELECT to_regprocedure('public.runtime_anonymize_deleted_account_annotations(text)') IS NOT NULL AS installed,
       (SELECT prosecdef FROM pg_proc WHERE oid=to_regprocedure('public.runtime_anonymize_deleted_account_annotations(text)')) AS security_definer,
       (SELECT r.rolsuper OR r.rolbypassrls FROM pg_proc p JOIN pg_roles r ON r.oid=p.proowner
          WHERE p.oid=to_regprocedure('public.runtime_anonymize_deleted_account_annotations(text)')) AS privileged_owner,
       position('PERFORM public.runtime_anonymize_deleted_account_annotations(account_id)' IN
         pg_get_functiondef(to_regprocedure('public.runtime_anonymize_deleted_account_history(text)')::oid)) > 0 AS entrypoint_calls,
       has_function_privilege('site_drevo','public.runtime_anonymize_deleted_account_annotations(text)','EXECUTE') AS app_helper_execute,
       (SELECT count(*) FROM documents d, jsonb_array_elements(d.annotations::jsonb) item
          JOIN deleted_account_tombstones t ON t.id=item->>'authorId'
          WHERE NOT EXISTS (SELECT 1 FROM accounts a WHERE a.id=t.id)) AS remaining_deleted_authors,
       (SELECT count(*) FROM documents d, jsonb_array_elements(d.annotations::jsonb) item
          JOIN deleted_account_tombstones t ON t.id=item->>'authorId'
          WHERE EXISTS (SELECT 1 FROM accounts a WHERE a.id=t.id)) AS ambiguous_reused_ids"
```

Версия 059 меняет только совпадающие ID и отображаемые имена авторов аннотаций в текущих
строках документов. Содержимое аннотаций, другие авторы, старые резервные копии и WAL
не переписываются.

Для версии 058 отдельно применяют привилегированный SQL до активации приложения: роль `site_drevo` не может заменить принадлежащую PostgreSQL функцию с `SECURITY DEFINER`. Прежний установочный скрипт ниже нужен для первоначальной установки и обновления остальных функций. После него всегда запускают 058. Повторный запуск 058 безопасен; миграция обезличивает только ID с маркером удаления и без действующего аккаунта. Повторно зарегистрированные ID требуют отдельной проверки: старое и новое авторство по одному ID различить нельзя.

```bash
set -euo pipefail
db=$(cat /var/www/drevo.kiiko.ru/shared/postgres.active)
[[ "$db" =~ ^[a-zA-Z_][a-zA-Z0-9_]*$ ]] || exit 1
cat /var/www/drevo.kiiko.ru/current/ops/postgres/install-account-history-anonymization.sql \
  | sudo -u postgres psql -X -v ON_ERROR_STOP=1 -d "$db"
```

До merge релизного каталога с 058 ещё нет: оператор переносит сверенный по
коммиту SQL во временный файл `/root/058_deleted_account_union_authors.sql`
с владельцем `root` и режимом `0600`, репетирует его на отдельной копии БД и
лишь после проверки применяет к рабочей БД. На новой установке сначала
выполните прежний скрипт выше. До активации не берите SQL из `current`:

```bash
test "$(stat -c '%U:%a' /root/058_deleted_account_union_authors.sql)" = root:600
preflight_db=drevo_union_058_preflight
sudo -u postgres createdb "$preflight_db"
sudo -u postgres pg_dump -Fc "$db" \
  | sudo -u postgres pg_restore --no-owner --exit-on-error -d "$preflight_db"
cat /root/058_deleted_account_union_authors.sql \
  | sudo -u postgres psql -X -v ON_ERROR_STOP=1 -d "$preflight_db"
```

Проверьте функции и количество строк в копии запросами ниже. После ревью
результатов выполните отдельный шаг для рабочей БД; временную БД затем можно
удалить командой `sudo -u postgres dropdb "$preflight_db"`:

```bash
cat /root/058_deleted_account_union_authors.sql \
  | sudo -u postgres psql -X -v ON_ERROR_STOP=1 -d "$db"
```

Следующая проверка только читает метаданные и не удаляет аккаунт. Должны получиться `f` для обоих прав роли приложения, `t` для наличия функции, права её вызова у `site_drevo` и запрета вызова для `PUBLIC`:

```bash
sudo -u postgres psql -X -v ON_ERROR_STOP=1 -d "$db" -c \
  "SELECT rolsuper,rolbypassrls FROM pg_roles WHERE rolname='site_drevo'"
sudo -u postgres psql -X -v ON_ERROR_STOP=1 -d "$db" -c \
  "SELECT p.oid IS NOT NULL AS installed,
          has_function_privilege('site_drevo',p.oid,'EXECUTE') AS app_execute,
          NOT EXISTS (
            SELECT 1 FROM aclexplode(COALESCE(p.proacl,acldefault('f',p.proowner))) acl
            WHERE acl.grantee=0 AND acl.privilege_type='EXECUTE'
          ) AS public_denied
   FROM pg_proc p WHERE p.oid=to_regprocedure('public.runtime_redact_deleted_account_comments(text)')"
sudo -u postgres psql -X -v ON_ERROR_STOP=1 -d "$db" -c \
  "SELECT position('PERFORM public.runtime_anonymize_deleted_account_unions(account_id)' IN
             pg_get_functiondef(to_regprocedure('public.runtime_anonymize_deleted_account_history(text)')::oid)) > 0 AS unions_installed,
           (SELECT prosecdef FROM pg_proc WHERE oid=to_regprocedure('public.runtime_anonymize_deleted_account_unions(text)')) AS helper_security_definer,
           (SELECT r.rolsuper OR r.rolbypassrls FROM pg_proc p JOIN pg_roles r ON r.oid=p.proowner
              WHERE p.oid=to_regprocedure('public.runtime_anonymize_deleted_account_unions(text)')) AS helper_owner_privileged,
           has_function_privilege('site_drevo','public.runtime_anonymize_deleted_account_history(text)','EXECUTE') AS app_deletion_execute,
           has_function_privilege('site_drevo','public.runtime_anonymize_deleted_account_unions(text)','EXECUTE') AS app_helper_execute,
           (SELECT count(*) FROM family_unions u JOIN deleted_account_tombstones d ON d.id=(u.data->>'createdBy')
              WHERE NOT EXISTS (SELECT 1 FROM accounts a WHERE a.id=d.id)) AS remaining_deleted_authors,
           (SELECT count(*) FROM family_unions u JOIN deleted_account_tombstones d ON d.id=(u.data->>'createdBy')
              WHERE EXISTS (SELECT 1 FROM accounts a WHERE a.id=d.id)) AS ambiguous_reused_ids"
```

После 058 поля `unions_installed`, `helper_security_definer`,
`helper_owner_privileged` и `app_deletion_execute` должны быть `t`,
`app_helper_execute` — `f`, `remaining_deleted_authors` — `0`.
`ambiguous_reused_ids` показывает строки для отдельного анализа; миграция их
не меняет.

После установки вошедший пользователь может безопасно проверить `GET /api/account/deletion`: поле `canRedactComments` должно быть `true`. Сам `DELETE` для проверки не вызывают. До этой проверки опция очистки текста в production не считается доступной.

Рабочий backend выбирает `/etc/drevo.env`: `DATABASE_BACKEND=postgres`, `PGHOST=/var/run/postgresql`, `PGPORT=5432`, `PGUSER=site_drevo`, `PGDATABASE`, `ARCHIVE_ID=legacy-primary`. Роль приложения не должна иметь superuser/BYPASSRLS. `DATABASE_PATH` остаётся путём-якорем для файлов и ключа, а не рабочей SQLite. Не удаляйте ключ при миграции.

Удаление аккаунта требует привилегированной функции истории, а начиная с версии 058 — и миграции авторства союзов. До установки 058 запрос `DELETE /api/account` отвечает конфликтом до создания маркера удаления и изменения данных. Миграция меняет только совпадающий `family_unions.data.createdBy` во всех архивах, сохраняя прочие поля союза. Резервные копии и WAL она не переписывает. Роль приложения остаётся без `BYPASSRLS` и не может вызвать внутреннюю функцию очистки союзов.

Базовая очистка заменяет ID и снимки имён авторов нейтральным маркером в текущих и ранее покинутых архивах; генеалогические факты и ревизии истории остаются. Вложенные `createdBy` в снимках истории заменяются только при точном совпадении ID удалённого аккаунта. Без отдельной галочки текст комментариев остаётся; с галочкой текущие строки комментариев удаляемого аккаунта заменяются нейтральной пометкой, а чужие комментарии сохраняются. Произвольный текст заметок и старые резервные копии, включая WAL и ранее выгруженные файлы, автоматически не переписываются. Они удаляются по отдельной политике хранения и ротации резервных копий.

Маркер `shared/postgres.active` запрещает запуск SQLite при утрате переменных. Его читает и CLI резервирования. `drevo-backup.service` должен загружать `/etc/drevo.env`; одной настройки HTTP-сервиса недостаточно.

Для PG-деплоя root устанавливает `ops/postgres/deploy-maintenance.sh` в `/usr/local/sbin/drevo-postgres-maintenance`, принадлежащий root, и разрешает `deploy` запуск этого helper через sudo. Helper проверяет пути и аргументы, создаёт нативный `pg_dump`, восстанавливает отдельную временную БД и проверяет новый и предыдущий релизы. Исходная БД не заменяется. Сборщик медиа пока сохраняет все оригиналы: межархивная очистка с учётом PostgreSQL-бэкапов ещё не реализована.

При первом развёртывании межархивного поиска сервер создаёт таблицу `discovery_people`, но `/api/discovery/people` отвечает 503, пока не заполнен индекс по всем архивам. После успешного деплоя администратор PostgreSQL выполняет `ops/postgres/backfill-discovery.sql` из текущего релиза в рабочей БД под ролью `postgres` с `ON_ERROR_STOP=1`. Скрипт в одной транзакции переносит только ранее разрешённые карточки умерших людей и открывает поиск после успешного завершения. При ошибке транзакция откатывается и API остаётся закрытым; повторный запуск безопасен. Сначала проверьте нативный бэкап и свободное место для индекса.

При установке миграции `061_discovery_copied_fields.sql` существующие разрешения на дополнительные scalar-поля связанных карточек однократно отзываются: прежняя схема не фиксировала согласие обоих текущих владельцев. Подтверждённые публичные связи сохраняются; владельцы могут заново выбрать и выдать поля. Повторный запуск миграции после появления триггера передачи владения не удаляет новые разрешения. При дальнейшей передаче владения разрешения обеих сторон для затронутых связей отзываются атомарно; уже явно скопированные сведения в своём архиве остаются.

Однократное переключение выполняет root через `ops/postgres/cutover.sh` из развёрнутого PG-совместимого релиза. До запуска требуется nginx-guard `/run/drevo-maintenance`. Скрипт закрывает входящие запросы, останавливает писателей, делает свежую согласованную копию и импортирует все таблицы в новую БД. Ошибка до открытия сайта возвращает неизменённую SQLite. После открытия записи в PostgreSQL автоматический возврат к старой SQLite запрещён: он потеряет новые изменения. [Проверки, резервирование и остаточные ограничения](postgres-migration.md).

Изменения unit, Nginx и привилегированного установочного сценария не устанавливаются автоматически обычным деплоем: их применяет администратор сервера. Это отделяет доставку кода от настройки соседних сайтов.

### Публичный MCP endpoint

`ops/nginx.conf` содержит отдельный exact-location `/mcp`: Bearer Authorization явно передаётся приложению, proxy buffering и request buffering отключены, а тайм-аут увеличен до 300 секунд. После обновления этого файла на сервере выполните `nginx -t` и reload Nginx.

Nginx отдаёт единственный `Referrer-Policy: no-referrer`, включая страницы общей ссылки; Referer исключён из access log, а секретные пути маскируются.

После выкладки создайте отдельный MCP-токен в «Управление → MCP-токены» и проверьте публичный endpoint:

```sh
MCP_TOKEN='drevo_mcp_...' bash ops/check-mcp.sh
```

По умолчанию проверяется `https://mydrevo.org/mcp`. Для другого адреса задайте `MCP_URL`. Скрипт делает modern `server/discover`, `tools/list` и безопасный `search_people` с заведомо тестовой строкой. Токен передаётся curl через временный config-файл с правами 600 и удаляется после проверки.

## Проверка и обслуживание

```sh
systemctl status drevo --no-pager
journalctl -u drevo -n 100 --no-pager
curl --fail http://127.0.0.1:3107/api/health
nginx -t
```

Логи Nginx: `/var/log/nginx/drevo.kiiko.ru/`. Сертификат обслуживает Certbot; проверьте, что после его продления настроена перезагрузка Nginx. Архивные данные восстанавливаются по [инструкции резервного копирования](backup.md).

Для возврата к сохранённому релизу запустите от `deploy`: `bash /var/www/drevo.kiiko.ru/releases/<релиз>/ops/deploy.sh <релиз>`. Этот сценарий не удаляет базу и фотографии.
