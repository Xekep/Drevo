import { useEffect, useState } from "react";
import {
  ArrowLeft,
  ArrowDownUp,
  Bot,
  DatabaseBackup,
  Download,
  ShieldCheck,
  Users,
  History,
  Link2,
  KeyRound,
  Trash2,
} from "lucide-react";
import {
  ROLE_NAMES,
  type ArchiveUser,
  type Role,
  type TreeAccess,
  type Family,
} from "../domain";
import { BackupRestore } from "./backup-restore";
import { ShareCatalog } from "./share-catalog";
import { AuditLog } from "./audit-log";
import { PersonSearch } from "./person-search";
import { GedcomTransfer } from "./gedcom-transfer";
import { McpTokenAdmin } from "./mcp-token-admin";
import { AiSettingsAdmin } from "./ai-settings-admin";
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
};
type UsersPage = { users: ArchiveUser[]; next: string | null; total: number };
const USERS_PAGE_SIZE = 20;

function AdminUserRow({
  user,
  family,
  busy,
  currentUserId,
  onPatch,
  onDelete,
}: {
  user: ArchiveUser;
  family: Family;
  busy: boolean;
  currentUserId: string;
  onPatch: (patch: UserPatch) => Promise<boolean>;
  onDelete: () => Promise<void>;
}) {
  const [personId, setPersonId] = useState(user.personId || "");
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
        <b>{user.name}</b>
        {!user.approved && <small>Ожидает одобрения</small>}
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
  onClose,
  onChanged,
  onSettings,
}: {
  family: Family;
  currentUserId: string;
  onClose: () => void;
  onChanged: () => void;
  onSettings: () => void;
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
    void fetch("/api/settings", { signal: controller.signal })
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
    void fetch(`/api/users?${query}`, { signal: controller.signal })
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
      const response = await fetch(url, {
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
          <ShieldCheck size={28} />
          <span>
            УПРАВЛЕНИЕ
            <br />
            <b>Семейный архив</b>
          </span>
        </div>
        <nav aria-label="Разделы админки">
          {[
            ["users", "Участники", Users],
            ["access", "Доступ и древо", ArrowDownUp],
            ["data", "Данные и копии", DatabaseBackup],
            ["ai", "Yandex AI", Bot],
            ["mcp", "MCP-токены", KeyRound],
            ["shares", "Временные ссылки", Link2],
            ["audit", "Журнал правок", History],
          ].map(([id, label, Icon]) => {
            const ItemIcon = Icon as typeof Users;
            return (
              <button
                key={String(id)}
                aria-current={section === id ? "page" : undefined}
                onClick={() => {
                  setSection(String(id));
                  setNotice("");
                }}
              >
                <ItemIcon size={18} />
                {String(label)}
              </button>
            );
          })}
        </nav>
        <button className="admin-back" onClick={onClose}>
          <ArrowLeft size={16} />
          Вернуться к древу
        </button>
      </aside>
      <div className="admin-content">
        <span className="section-label">АДМИНИСТРАТОР</span>
        <h1>Управление архивом</h1>
        <p className="admin-subtitle">
          Доступ для семьи, вид древа и сохранность вашей истории.
        </p>
        {!settings && !error && <p role="status">Загружаем настройки…</p>}
        {settings && section === "users" && (
          <section className="admin-card archive-form">
            <h2>Участники и роли</h2>
            <p>
              Новые пользователи ожидают одобрения. Читатель видит закрытый
              архив после допуска, родственник редактирует свои объекты,
              администратор управляет всем архивом.
            </p>
            {(settings.publicTree || settings.publicAlbums) && (
              <p role="note" className="form-error">
                Для доступа по общим предкам сначала закройте публичное древо и
                альбомы в разделе «Доступ и древо».
              </p>
            )}
            {!usersLoading && usersTotal === 0 && (
              <p>
                После первого входа через Яндекс здесь появятся участники. На
                этом компьютере управление доступно без входа.
              </p>
            )}
            <div className="admin-users-toolbar">
              <span>Всего участников: {usersTotal}</span>
              <span role="status">{busy ? "Сохраняем…" : notice}</span>
            </div>
            {usersLoading ? (
              <p role="status">Загружаем участников…</p>
            ) : (
              users.length > 0 && (
                <div
                  className="admin-users-list"
                  aria-label="Список участников"
                >
                  <div className="admin-users-head" aria-hidden="true">
                    <span>Участник</span>
                    <span>Роль</span>
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
        {settings && section === "access" && (
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
            <h2>Направление времени</h2>
            <p>
              Настройка действует для всех: эпохи, века, люди и связи меняют
              направление вместе.
            </p>
            <div className="timeline-options">
              <label className={!settings.reverseTimeline ? "selected" : ""}>
                <input
                  type="radio"
                  name="timeline"
                  checked={!settings.reverseTimeline}
                  onChange={() =>
                    setSettings({ ...settings, reverseTimeline: false })
                  }
                />
                <b>Предки сверху</b>
                <span>Империя → СССР → Россия</span>
                <small>От прошлого к настоящему, сверху вниз</small>
              </label>
              <label className={settings.reverseTimeline ? "selected" : ""}>
                <input
                  type="radio"
                  name="timeline"
                  checked={settings.reverseTimeline}
                  onChange={() =>
                    setSettings({ ...settings, reverseTimeline: true })
                  }
                />
                <b>Младшие сверху</b>
                <span>Россия → СССР → Империя</span>
                <small>От настоящего к прошлому, сверху вниз</small>
              </label>
            </div>
            <footer>
              <button className="primary-action" disabled={busy}>
                {busy ? "Сохраняем…" : "Сохранить настройки"}
              </button>
            </footer>
          </form>
        )}
        {section === "ai" && <AiSettingsAdmin />}
        {section === "mcp" && <McpTokenAdmin />}
        {section === "shares" && <ShareCatalog />}
        {section === "audit" && (
          <section className="admin-card archive-form">
            <h2>Журнал правок</h2>
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
        {section === "data" && (
          <section className="admin-card archive-form">
            <h2>Резервные копии</h2>
            <p>
              Скачайте весь архив с фотографиями или только базу. В базу входят
              карточки, связи, отметки, участники и настройки.
            </p>
            <div className="backup-actions">
              <a className="primary-action" href="/api/backup/full" download>
                <DatabaseBackup size={18} />
                Скачать базу и фото
              </a>
              <a href="/api/backup" download>
                Только база SQLite
              </a>
            </div>
            <hr />
            <BackupRestore onRestored={onChanged} />
            <hr />
            <GedcomTransfer onImported={onChanged} />
            <hr />
            <h2>Настройки и перенос данных</h2>
            <a href="/api/export.json?download=1" download="drevo-family.json">
              <Download size={18} /> Экспорт JSON без фото
            </a>
            <p>
              Карточки и связи для анализа. Для восстановления используйте
              резервную копию.
            </p>
            <p>Название архива, описание и импорт сохранённого JSON.</p>
            <button onClick={onSettings}>Открыть настройки данных</button>
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
