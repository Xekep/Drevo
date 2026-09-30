import { archiveFetch } from "../data/archive-fetch.ts";
import { useEffect, useState } from "react";
import {
  ArrowLeft,
  Bot,
  BookOpen,
  DatabaseBackup,
  Download,
  ShieldCheck,
  Users,
  History,
  Link2,
  KeyRound,
  Trash2,
  Clock3,
} from "lucide-react";
import {
  ROLE_NAMES,
  type ArchiveUser,
  type Role,
  type TreeAccess,
  type Family,
} from "../domain";
import { BackupAdmin } from "./backup-admin";
import { ShareCatalog } from "./share-catalog";
import { AuditLog } from "./audit-log";
import { PersonSearch } from "./person-search";
import { GedcomTransfer } from "./gedcom-transfer";
import { McpTokenAdmin } from "./mcp-token-admin";
import { AiSettingsAdmin } from "./ai-settings-admin";
import { VkAuthAdmin } from "./vk-auth-admin";
import { ResearchResourcesAdmin } from "./research-resources-admin";
type Settings = {
  publicTree: boolean;
  publicAlbums: boolean;
  reverseTimeline: boolean;
};
type UserPatch = {
  role?: Role;
  approved?: boolean;
  personId?: string | null;
  treeAccess?: TreeAccess;
  fullAccess?: boolean;
};
type UsersPage = { users: ArchiveUser[]; next: string | null; total: number };
const USERS_PAGE_SIZE = 20;
const ADMIN_SECTIONS = [
  {
    label: "Доступ",
    items: [
      { id: "users", label: "Участники", icon: Users },
      { id: "vk", label: "Вход через VK", icon: ShieldCheck },
      { id: "shares", label: "Общий доступ", icon: Link2 },
    ],
  },
  {
    label: "ИИ и источники",
    items: [
      { id: "ai", label: "Yandex AI", icon: Bot },
      { id: "resources", label: "Ресурсы поиска", icon: BookOpen },
      { id: "mcp", label: "MCP-токены", icon: KeyRound },
    ],
  },
  {
    label: "Данные",
    items: [
      { id: "data", label: "Экспорт и импорт", icon: Download },
      { id: "backups", label: "Резервные копии", icon: DatabaseBackup },
    ],
  },
  {
    label: "История",
    items: [{ id: "audit", label: "Журнал правок", icon: History }],
  },
] as const;
const ADMIN_INTRO: Record<string, { title: string; description: string }> = {
  vk: {
    title: "Вход через VK",
    description: "Подключение VK ID для входа в архив.",
  },
  users: {
    title: "Участники",
    description: "Аккаунты, роли и доступ к семейному архиву.",
  },
  data: {
    title: "Экспорт и импорт",
    description: "Обмен данными и перенос в другие генеалогические программы.",
  },
  backups: {
    title: "Резервные копии",
    description: "Расписание, хранилище и восстановление семейного архива.",
  },
  ai: {
    title: "ИИ и поиск",
    description: "Доступ по ролям, возможности и подключение провайдера.",
  },
  resources: {
    title: "Ресурсы поиска",
    description:
      "Категории и сайты, которые ИИ может предложить для дальнейшего исследования.",
  },
  mcp: {
    title: "MCP-токены",
    description: "Доступ внешних клиентов к инструментам архива.",
  },
  shares: {
    title: "Общий доступ",
    description: "Публичный просмотр и временные ссылки на семейные ветви.",
  },
  audit: {
    title: "Журнал правок",
    description: "История изменений и действий участников.",
  },
};

function AdminUserRow({
  user,
  family,
  busy,
  currentUserId,
  platformAdmin,
  onPatch,
  onDelete,
}: {
  user: ArchiveUser;
  family: Family;
  busy: boolean;
  currentUserId: string;
  platformAdmin: boolean;
  onPatch: (patch: UserPatch) => Promise<boolean>;
  onDelete: () => Promise<void>;
}) {
  const [personId, setPersonId] = useState(user.personId || "");
  const lastVisit = user.lastVisitAt ? new Date(user.lastVisitAt) : null;
  const visitText =
    lastVisit && Number.isFinite(lastVisit.getTime())
      ? lastVisit.toLocaleString("ru-RU", {
          day: "2-digit",
          month: "2-digit",
          year: "numeric",
          hour: "2-digit",
          minute: "2-digit",
        })
      : null;
  async function commitPerson(nextId: string) {
    const saved = await onPatch({
      personId: nextId || null,
      treeAccess: nextId ? user.treeAccess || "all" : "all",
    });
    if (!saved) setPersonId(user.personId || "");
  }
  return (
    <article className="admin-user-row" aria-label={`Участник: ${user.name}`}>
      <div className="admin-user-name" title={user.name}>
        <span className="admin-user-avatar" aria-hidden="true">
          {user.name.trim().slice(0, 1).toLocaleUpperCase("ru-RU") || "?"}
        </span>
        <span className="admin-user-identity">
          <b>{user.name}</b>
          <small
            className="admin-user-visit"
            title={
              visitText
                ? `Последний визит: ${visitText} (ваш часовой пояс)`
                : "Последний визит пока не зафиксирован"
            }
          >
            <Clock3 size={11} aria-hidden="true" />
            {visitText ? (
              <time
                dateTime={user.lastVisitAt}
                aria-label={`Последний визит: ${visitText}`}
              >
                {visitText}
              </time>
            ) : (
              <span>Нет данных о визите</span>
            )}
          </small>
          {!user.approved && <small>Ожидает одобрения</small>}
        </span>
      </div>
      <label className="admin-user-select">
        <span>Роль</span>
        <select
          aria-label={`Роль: ${user.name}`}
          value={user.role}
          disabled={busy}
          onChange={(event) =>
            void onPatch({ role: event.target.value as Role })
          }
        >
          {Object.entries(ROLE_NAMES).map(([role, label]) => (
            <option key={role} value={role}>
              {label}
            </option>
          ))}
        </select>
      </label>
      {platformAdmin && user.fullAccess !== undefined && (
        <label className="admin-user-select">
          <span>Уровень аккаунта</span>
          <select
            aria-label={`Уровень аккаунта: ${user.name}`}
            value={user.fullAccess ? "full" : "basic"}
            disabled={busy}
            onChange={(event) =>
              void onPatch({ fullAccess: event.target.value === "full" })
            }
          >
            <option value="basic">Базовый</option>
            <option value="full">Полный</option>
          </select>
        </label>
      )}
      <PersonSearch
        label="Кто это в древе"
        inputAriaLabel={`Кто это в древе: ${user.name}`}
        clearLabel={`Убрать привязку: ${user.name}`}
        value={personId}
        selected={family.people.find((person) => person.id === personId)}
        disabled={busy}
        onChange={setPersonId}
        onCommit={(id) => void commitPerson(id)}
        onCancel={() => setPersonId(user.personId || "")}
      />
      <label className="admin-user-select">
        <span>Показывать</span>
        <select
          aria-label={`Доступ к древу: ${user.name}`}
          value={user.personId ? user.treeAccess || "all" : "all"}
          disabled={busy || user.role === "admin" || !user.personId}
          onChange={(event) =>
            void onPatch({
              personId: user.personId || null,
              treeAccess: event.target.value as TreeAccess,
            })
          }
        >
          <option value="all">Всё древо</option>
          <option value="common_ancestors">Общие предки</option>
        </select>
      </label>
      <div className="admin-user-actions">
        {!user.approved && (
          <button
            type="button"
            disabled={busy}
            onClick={() => void onPatch({ approved: true })}
          >
            Одобрить
          </button>
        )}
        <button
          type="button"
          className="admin-user-delete"
          disabled={busy || user.id === currentUserId}
          aria-label={`Удалить участника: ${user.name}`}
          title={
            user.id === currentUserId
              ? "Свой аккаунт удалить нельзя"
              : "Удалить участника"
          }
          onClick={() => {
            if (
              window.confirm(
                `Удалить участника «${user.name}»? Его данные в древе сохранятся. При новом входе он снова появится и будет ждать одобрения.`,
              )
            )
              void onDelete();
          }}
        >
          <Trash2 size={16} />
        </button>
      </div>
    </article>
  );
}
export function AdminPanel({
  family,
  currentUserId,
  platformAdmin,
  onClose,
  onChanged,
  onSettings,
  save,
  canEdit,
}: {
  family: Family;
  currentUserId: string;
  platformAdmin: boolean;
  onClose: () => void;
  onChanged: () => void;
  onSettings: () => void;
  save: (family: Family) => Promise<Family>;
  canEdit: boolean;
}) {
  const [section, setSection] = useState("users"),
    [users, setUsers] = useState<ArchiveUser[]>([]),
    [usersTotal, setUsersTotal] = useState(0),
    [usersNext, setUsersNext] = useState<string | null>(null),
    [usersCursor, setUsersCursor] = useState<string | null>(null),
    [usersHistory, setUsersHistory] = useState<(string | null)[]>([]),
    [usersReload, setUsersReload] = useState(0),
    [usersLoading, setUsersLoading] = useState(true),
    [settings, setSettings] = useState<Settings | null>(null),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false),
    [notice, setNotice] = useState("");
  const [auditActor, setAuditActor] = useState("");
  useEffect(() => {
    const controller = new AbortController();
    void archiveFetch("/api/settings", { signal: controller.signal })
      .then(async (response) => {
        if (!response.ok) throw new Error("Нет доступа к управлению архивом");
        setSettings(await response.json());
      })
      .catch((e) => {
        if (!controller.signal.aborted) setError(e.message);
      });
    return () => controller.abort();
  }, []);
  useEffect(() => {
    const controller = new AbortController();
    const query = new URLSearchParams({ limit: String(USERS_PAGE_SIZE) });
    if (usersCursor) query.set("cursor", usersCursor);
    void archiveFetch(`/api/users?${query}`, { signal: controller.signal })
      .then(async (response) => {
        const data = await response.json();
        if (!response.ok)
          throw new Error(data.error || "Не удалось загрузить участников");
        const page = data as UsersPage;
        setUsers(page.users);
        setUsersNext(page.next);
        setUsersTotal(page.total);
      })
      .catch((reason) => {
        if (!controller.signal.aborted) {
          setUsers([]);
          setUsersNext(null);
          setError((reason as Error).message);
        }
      })
      .finally(() => {
        if (!controller.signal.aborted) setUsersLoading(false);
      });
    return () => controller.abort();
  }, [usersCursor, usersReload]);
  async function change(url: string, method: string, body?: unknown) {
    setBusy(true);
    setError("");
    setNotice("");
    try {
      const response = await archiveFetch(url, {
        method,
        ...(body === undefined
          ? {}
          : {
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify(body),
            }),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "Не удалось сохранить");
      onChanged();
      setNotice("Изменения сохранены");
      return data;
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <main className="admin-page">
      <aside className="admin-sidebar">
        <div className="admin-mark">
          <span className="admin-mark-icon">
            <ShieldCheck size={20} />
          </span>
          <span>
            <small>DREVO</small>
            <b>Управление архивом</b>
          </span>
        </div>
        <label className="admin-mobile-section" htmlFor="admin-section-select">
          Раздел
          <select
            id="admin-section-select"
            value={section}
            onChange={(event) => {
              setSection(event.target.value);
              setNotice("");
            }}
          >
            {ADMIN_SECTIONS.map((group) => (
              <optgroup key={group.label} label={group.label}>
                {group.items
                  .filter(({ id }) => id !== "backups" || platformAdmin)
                  .map((item) => (
                    <option key={item.id} value={item.id}>
                      {item.label}
                    </option>
                  ))}
              </optgroup>
            ))}
          </select>
        </label>
        <nav aria-label="Разделы админки">
          {ADMIN_SECTIONS.map((group) => (
            <div className="admin-nav-group" key={group.label}>
              <span className="admin-nav-label">{group.label}</span>
              {group.items
                .filter(({ id }) => id !== "backups" || platformAdmin)
                .map(({ id, label, icon: Icon }) => (
                  <button
                    key={id}
                    type="button"
                    aria-current={section === id ? "page" : undefined}
                    onClick={() => {
                      setSection(id);
                      setNotice("");
                    }}
                  >
                    <Icon size={17} aria-hidden="true" />
                    {label}
                  </button>
                ))}
            </div>
          ))}
        </nav>
        <button className="admin-back" type="button" onClick={onClose}>
          <ArrowLeft size={16} />
          Вернуться к древу
        </button>
      </aside>
      <div className="admin-content">
        <header className="admin-page-header">
          <span className="section-label">УПРАВЛЕНИЕ АРХИВОМ</span>
          <h1>{ADMIN_INTRO[section].title}</h1>
          <p className="admin-subtitle">{ADMIN_INTRO[section].description}</p>
        </header>
        {!settings && !error && <p role="status">Загружаем настройки…</p>}
        {settings && section === "users" && (
          <section className="admin-card archive-form">
            <p>
              Новые пользователи ожидают одобрения. Читатель видит закрытый
              архив после допуска, родственник редактирует свои объекты,
              администратор управляет всем архивом.
            </p>
            {(settings.publicTree || settings.publicAlbums) && (
              <p role="note" className="form-error">
                Для доступа по общим предкам сначала закройте публичное древо и
                альбомы в разделе «Общий доступ».
              </p>
            )}
            {!usersLoading && usersTotal === 0 && (
              <p>
                После первого входа через Яндекс здесь появятся участники. На
                этом компьютере управление доступно без входа.
              </p>
            )}
            <div className="admin-users-toolbar">
              <span>
                Всего участников <b>{usersTotal}</b>
              </span>
              <span role="status">{busy ? "Сохраняем…" : notice}</span>
            </div>
            {usersLoading ? (
              <p role="status">Загружаем участников…</p>
            ) : (
              users.length > 0 && (
                <div
                  className={`admin-users-list${platformAdmin && users.some((user) => user.fullAccess !== undefined) ? " with-account-tier" : ""}`}
                  aria-label="Список участников"
                >
                  <div className="admin-users-head" aria-hidden="true">
                    <span>Участник</span>
                    <span>Роль</span>
                    {platformAdmin && users.some((user) => user.fullAccess !== undefined) && <span>Уровень</span>}
                    <span>Кто это в древе</span>
                    <span>Показывать</span>
                    <span>Действия</span>
                  </div>
                  {users.map((user) => (
                    <AdminUserRow
                      key={`${user.id}:${user.personId || ""}`}
                      user={user}
                      family={family}
                      busy={busy}
                      currentUserId={currentUserId}
                      platformAdmin={platformAdmin}
                      onPatch={async (patch) => {
                        const data = await change(
                          `/api/users/${encodeURIComponent(user.id)}`,
                          "PATCH",
                          patch,
                        );
                        if (!data?.user) return false;
                        setUsers((current) =>
                          current.map((item) =>
                            item.id === user.id ? data.user : item,
                          ),
                        );
                        return true;
                      }}
                      onDelete={async () => {
                        const data = await change(
                          `/api/users/${encodeURIComponent(user.id)}`,
                          "DELETE",
                        );
                        if (!data?.deleted) return;
                        setUsersLoading(true);
                        if (users.length === 1 && usersHistory.length) {
                          setUsersCursor(usersHistory.at(-1) || null);
                          setUsersHistory((current) => current.slice(0, -1));
                        } else setUsersReload((current) => current + 1);
                      }}
                    />
                  ))}
                </div>
              )
            )}
            {(usersHistory.length > 0 || usersNext) && (
              <nav
                className="admin-users-pagination"
                aria-label="Страницы участников"
              >
                <button
                  type="button"
                  disabled={busy || usersLoading || !usersHistory.length}
                  onClick={() => {
                    setUsersLoading(true);
                    setUsersCursor(usersHistory.at(-1) || null);
                    setUsersHistory((current) => current.slice(0, -1));
                  }}
                >
                  Назад
                </button>
                <span>Страница {usersHistory.length + 1}</span>
                <button
                  type="button"
                  disabled={busy || usersLoading || !usersNext}
                  onClick={() => {
                    setUsersLoading(true);
                    setUsersHistory((current) => [...current, usersCursor]);
                    setUsersCursor(usersNext);
                  }}
                >
                  Далее
                </button>
              </nav>
            )}
            {error && (
              <p role="alert" className="form-error">
                {error}
              </p>
            )}
          </section>
        )}
        {section === "shares" && (
          <section className="admin-card archive-form">
            <h2>Название и описание архива</h2>
            <button type="button" disabled={!canEdit} onClick={onSettings}>
              Изменить название и описание
            </button>
            {!canEdit && <small>Редактирование доступно с компьютера.</small>}
          </section>
        )}
        {settings && section === "shares" && (
          <form
            className="admin-card archive-form"
            onSubmit={async (e) => {
              e.preventDefault();
              const saved = await change("/api/settings", "PUT", settings);
              if (saved) setSettings(saved);
            }}
          >
            <h2>Публичный просмотр</h2>
            <p>Выберите, что смогут видеть гости без входа в аккаунт.</p>
            <label
              className="setting-toggle"
              htmlFor="public-tree"
              aria-label="Публичное древо и семьи"
            >
              <span>
                <b>Древо и семьи</b>
                <small>Люди, карточки и родственные связи</small>
              </span>
              <input
                type="checkbox"
                id="public-tree"
                checked={settings.publicTree}
                onChange={(e) =>
                  setSettings({ ...settings, publicTree: e.target.checked })
                }
              />
            </label>
            <label
              className="setting-toggle"
              htmlFor="public-albums"
              aria-label="Публичные фотоальбомы"
            >
              <span>
                <b>Фотоальбомы</b>
                <small>Фотографии и описания снимков</small>
              </span>
              <input
                type="checkbox"
                id="public-albums"
                checked={settings.publicAlbums}
                onChange={(e) =>
                  setSettings({ ...settings, publicAlbums: e.target.checked })
                }
              />
            </label>
            <footer>
              <button className="primary-action" disabled={busy}>
                {busy ? "Сохраняем…" : "Сохранить настройки"}
              </button>
            </footer>
          </form>
        )}
        {section === "ai" && <AiSettingsAdmin />}
        {section === "vk" && <VkAuthAdmin />}
        {section === "resources" && <ResearchResourcesAdmin />}
        {section === "mcp" && <McpTokenAdmin />}
        {section === "shares" && <ShareCatalog />}
        {section === "audit" && (
          <section className="admin-card archive-form">
            <label>
              Кто изменил
              <select
                value={auditActor}
                onChange={(e) => setAuditActor(e.target.value)}
              >
                <option value="">Все участники</option>
                {users.map((u) => (
                  <option key={u.id} value={u.id}>
                    {u.name}
                  </option>
                ))}
                <option value="system">Система</option>
              </select>
            </label>
            <AuditLog key={auditActor} actorId={auditActor || undefined} />
          </section>
        )}
        {section === "backups" && platformAdmin && (
          <BackupAdmin onRestored={onChanged} />
        )}
        {section === "data" && (
          <section className="admin-card archive-form">
            <GedcomTransfer
              onImported={onChanged}
              save={save}
              canEdit={canEdit}
            />
          </section>
        )}
        {error && section !== "users" && (
          <p role="alert" className="form-error">
            {error}
          </p>
        )}
        {notice && section !== "users" && (
          <p className="admin-notice" role="status">
            {notice}
          </p>
        )}
      </div>
    </main>
  );
}
