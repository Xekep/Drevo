import { BackupAdmin } from "./backup-admin";
import { archiveFetch } from "../data/archive-fetch.ts";
import { useEffect, useRef, useState } from "react";
import {
  ArrowLeft,
  BookOpen,
  Download,
  ShieldCheck,
  Users,
  History,
  Link2,
  Trash2,
  Clock3,
  ScanSearch,
  GitCompareArrows,
  Eye,
  DatabaseBackup,
  Check,
} from "lucide-react";
import {
  ROLE_NAMES,
  isArchiveOwner,
  type ArchiveUser,
  type Role,
  type TreeAccess,
  type Family,
} from "../domain";
import { ShareCatalog } from "./share-catalog";
import { InvitationsAdmin } from "./invitations-admin";
import { AuditLog } from "./audit-log";
import { PersonSearch } from "./person-search";
import { GedcomTransfer } from "./gedcom-transfer";
import { SourceCatalogAdmin } from "./source-catalog-admin";
import { PublicationAdmin } from "./publication-admin";
import type { PublicationOwnership } from "../hooks/useArchivePublicationOwner";
import { DiscoveryMatchesAdmin } from "./discovery-matches-admin";
import { adminMatchesPath, adminMatchSourceAt, adminMatchTargetAt, archivePaths } from "../domain/archive-routes";
import { archiveContextAt, memberPreviewPath, scopedArchivePath } from "../domain/archive-context";
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
      { id: "invitations", label: "Приглашения", icon: Link2 },
      { id: "shares", label: "Общий доступ", icon: Link2 },
      { id: "publications", label: "Можно найти", icon: ScanSearch },
      { id: "matches", label: "Связи древ", icon: GitCompareArrows },
    ],
  },
  {
    label: "Источники",
    items: [
      { id: "sources", label: "Источники", icon: BookOpen },
    ],
  },
  {
    label: "Данные",
    items: [
      { id: "backups", label: "Резервные копии", icon: DatabaseBackup },
      { id: "data", label: "Экспорт и импорт", icon: Download },
    ],
  },
  {
    label: "История",
    items: [{ id: "audit", label: "Журнал правок", icon: History }],
  },
] as const;
const ADMIN_INTRO: Record<string, { title: string; description: string }> = {
  backups: { title: "Резервные копии древа", description: "Ручные копии этого архива. Сохраняются пять последних." },
  users: {
    title: "Участники",
    description: "Аккаунты, роли и доступ к семейному архиву.",
  },
  invitations: {
    title: "Приглашения",
    description: "Одноразовые ссылки для новых участников этого древа.",
  },
  data: {
    title: "Экспорт и импорт",
    description: "Обмен данными и перенос в другие генеалогические программы.",
  },
  sources: {
    title: "Источники",
    description: "Архивные записи, документы и доказательства фактов.",
  },
  shares: {
    title: "Общий доступ",
    description: "Публичный просмотр и временные ссылки на семейные ветви.",
  },
  publications: {
    title: "Можно найти в Drevo",
    description:
      "Выберите людей и точные поля, доступные другим участникам через поиск.",
  },
  matches: {
    title: "Связи древ",
    description:
      "Сопоставление опубликованных людей между разными семейными архивами.",
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
  const [deleteArmed, setDeleteArmed] = useState(false);
  useEffect(() => {
    if (!deleteArmed) return;
    const timer = window.setTimeout(() => setDeleteArmed(false), 8000);
    return () => window.clearTimeout(timer);
  }, [deleteArmed]);
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
          value={user.treeRole || user.role}
          disabled={busy || user.archiveOwner === true}
          onChange={(event) =>
            void onPatch({ role: event.target.value as Role })
          }
        >
          {Object.entries(ROLE_NAMES)
            .filter(([role]) => !user.treeRole || role === "reader" || role === "relative")
            .map(([role, label]) => (
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
          title="Кровные родственники привязанного человека и их супруги или партнёры"
          value={user.personId ? user.treeAccess || "all" : "all"}
          disabled={busy || isArchiveOwner(user) || !user.personId}
          onChange={(event) =>
            void onPatch({
              personId: user.personId || null,
              treeAccess: event.target.value as TreeAccess,
            })
          }
        >
          <option value="all">Всё древо</option>
          <option value="common_ancestors">Кровные родственники</option>
        </select>
      </label>
      <div className="admin-user-actions">
        {!user.approved && (
          <button
            className="admin-user-approve"
            type="button"
            disabled={busy}
            onClick={() => void onPatch({ approved: true })}
          >
            Одобрить
          </button>
        )}
        <a
          className="admin-user-preview"
          href={memberPreviewPath(archiveContextAt(window.location.pathname)?.id || null, user.id)}
          aria-label={`Посмотреть как участник: ${user.name}`}
          title={`Посмотреть как участник: ${user.name}`}
          aria-disabled={busy || undefined}
          onClick={(event) => { if (busy) event.preventDefault(); }}
        >
          <Eye size={16} aria-hidden="true" />
        </a>
        <button
          type="button"
          className="admin-user-delete"
          disabled={busy || user.id === currentUserId || isArchiveOwner(user)}
          aria-label={`${deleteArmed ? "Подтвердить удаление участника" : "Удалить участника"}: ${user.name}`}
          title={
            user.id === currentUserId || isArchiveOwner(user)
              ? "Владельца древа удалить нельзя"
              : deleteArmed ? "Нажмите ещё раз, чтобы закрыть доступ к этому древу" : "Удалить доступ к этому древу"
          }
          onBlur={() => setDeleteArmed(false)}
          onKeyDown={(event) => { if (event.key === "Escape") setDeleteArmed(false); }}
          onClick={() => {
            if (!deleteArmed) { setDeleteArmed(true); return; }
            setDeleteArmed(false);
            void onDelete();
          }}
        >
          {deleteArmed ? <Check size={16} /> : <Trash2 size={16} />}
        </button>
      </div>
      {deleteArmed && <small className="admin-user-delete-confirm" role="status">
        Нажмите ✓ ещё раз, чтобы закрыть доступ. Аккаунт и данные в древе сохранятся. Esc — отмена.
      </small>}
    </article>
  );
}
export function AdminPanel({
  family,
  currentUserId,
  archiveOwner = true,
  backupAccess = false,
  platformAdmin,
  publicationOwnership,
  onClose,
  onChanged,
  save,
  canEdit,
}: {
  family: Family;
  currentUserId: string;
  archiveOwner?: boolean;
  backupAccess?: boolean;
  platformAdmin: boolean;
  publicationOwnership: PublicationOwnership;
  onClose: () => void;
  onChanged: () => void;
  save: (family: Family) => Promise<Family>;
  canEdit: boolean;
}) {
  const [section, setSection] = useState(() => {
    if (typeof window === "undefined") return "users";
    return [adminMatchesPath, "/admin/matches"].includes(
      archiveContextAt(window.location.pathname)?.innerPath || window.location.pathname) ||
      adminMatchTargetAt(window.location.pathname) ||
      adminMatchSourceAt(window.location.pathname)
      ? "matches" : new URLSearchParams(window.location.search).get("section") || "users";
  }),
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
  const visibleGroups = ADMIN_SECTIONS.map((group) => ({
    ...group,
    items: group.items.filter((item) => archiveOwner && (item.id !== "backups" || backupAccess)),
  })).filter((group) => group.items.length > 0);
  const visibleSection = visibleGroups.some((group) => group.items.some((item) => item.id === section))
    ? section : visibleGroups[0]?.items[0]?.id || "users";
  const navigation = useRef<HTMLElement>(null);
  useEffect(() => {
    const nav = navigation.current;
    if (!nav) return;
    const revealSelected = () => {
      if (nav.scrollWidth <= nav.clientWidth) return;
      const selected = nav.querySelector('[aria-current="page"]');
      if (!selected) return;
      const bounds = nav.getBoundingClientRect();
      const item = selected.getBoundingClientRect();
      if (item.left < bounds.left) nav.scrollLeft += item.left - bounds.left;
      else if (item.right > bounds.right) nav.scrollLeft += item.right - bounds.right;
    };
    revealSelected();
    const observer = new ResizeObserver(revealSelected);
    observer.observe(nav);
    return () => observer.disconnect();
  }, [visibleSection]);
  const selectSection = (next: string) => {
    if (!visibleGroups.some((group) => group.items.some((item) => item.id === next))) return;
    setSection(next);
    setNotice("");
    const path = scopedArchivePath(next === "matches" ? adminMatchesPath : archivePaths.manage);
    const url = next === "users" || next === "matches" ? path : `${path}?section=${next}`;
    if (window.location.pathname + window.location.search !== url)
      window.history.replaceState(window.history.state, "", url);
  };
  useEffect(() => {
    if (visibleSection !== section)
      window.history.replaceState(window.history.state, "", scopedArchivePath(archivePaths.manage));
  }, [section, visibleSection]);
  useEffect(() => {
    if (!archiveOwner) return;
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
  }, [archiveOwner]);
  useEffect(() => {
    if (!archiveOwner) return;
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
  }, [archiveOwner, usersCursor, usersReload]);
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
            <b>Управление древом</b>
          </span>
        </div>
        <nav ref={navigation} aria-label="Разделы админки">
          {visibleGroups.map((group) => (
            <div className="admin-nav-group" key={group.label}>
              <span className="admin-nav-label">{group.label}</span>
              {group.items.map(({ id, label, icon: Icon }) => (
                  <button
                    key={id}
                    type="button"
                    aria-current={visibleSection === id ? "page" : undefined}
                    onClick={() => {
                      selectSection(id);
                    }}
                  >
                    <Icon size={17} aria-hidden="true" />
                    {label}
                  </button>
                ))}
            </div>
          ))}
        </nav>
        <button
          className="admin-back"
          type="button"
          onClick={onClose}
          aria-label="Вернуться к древу"
          title="Вернуться к древу"
        >
          <ArrowLeft size={16} aria-hidden="true" />
          <span>Вернуться к древу</span>
        </button>
      </aside>
      <div className="admin-content">
        <header className="admin-page-header">
          <span className="section-label">УПРАВЛЕНИЕ ДРЕВОМ</span>
          <h1>{ADMIN_INTRO[visibleSection].title}</h1>
          {(publicationOwnership === "owner" ||
            (visibleSection !== "publications" && visibleSection !== "matches")) &&
            <p className="admin-subtitle">{ADMIN_INTRO[visibleSection].description}</p>}
        </header>
        {archiveOwner && !settings && !error && <p role="status">Загружаем настройки…</p>}
        {settings && visibleSection === "users" && (
          <section className="admin-card archive-form">
            <p>
              Новые пользователи ожидают одобрения. Читатель видит закрытый
              архив после допуска, родственник редактирует свои объекты,
              владелец управляет участниками и содержимым архива.
              Публикацией людей и связями древ управляет владелец.
            </p>
            {(settings.publicTree || settings.publicAlbums) && (
              <p role="note" className="form-error">
                Для доступа только к кровным родственникам и их супругам сначала закройте публичное древо и
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
                    {platformAdmin &&
                      users.some((user) => user.fullAccess !== undefined) && (
                        <span>Уровень</span>
                      )}
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
        {settings && visibleSection === "shares" && (
          <form
            className="admin-card archive-form"
            onSubmit={async (e) => {
              e.preventDefault();
              const saved = await change("/api/settings", "PUT", settings);
              if (saved) setSettings(saved);
            }}
          >
            <h2>Публичный просмотр</h2>
            <p>Откройте всё древо по ссылке для гостей без входа. Публикация отдельных людей в общем поиске настраивается отдельно.</p>
            <label
              className="setting-toggle"
              htmlFor="public-tree"
              aria-label="Всё древо по ссылке"
            >
              <span>
                <b>Всё древо по ссылке</b>
                <small>Все люди, их карточки, семьи и родственные связи</small>
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
        {visibleSection === "sources" && <SourceCatalogAdmin family={family} onChanged={onChanged} />}
        {visibleSection === "shares" && <ShareCatalog />}
        {visibleSection === "publications" && (publicationOwnership === "owner"
          ? <PublicationAdmin family={family} />
          : <section className="admin-card archive-form"><p role="status">{
            publicationOwnership === "checking" ? "Проверяем право на публикацию…"
              : publicationOwnership === "unavailable" ? "Не удалось проверить право на публикацию. Обновите страницу и повторите попытку."
                : "Публикацией людей управляет владелец древа."
          }</p></section>)}
        {visibleSection === "matches" && (publicationOwnership === "owner"
          ? <DiscoveryMatchesAdmin family={family} />
          : <section className="admin-card archive-form"><p role="status">{
            publicationOwnership === "checking" ? "Проверяем право на сопоставление…"
              : publicationOwnership === "unavailable" ? "Не удалось проверить право на сопоставление. Обновите страницу и повторите попытку."
                : "Связями с другими древами управляет владелец древа."
          }</p></section>)}
        {visibleSection === "invitations" && <InvitationsAdmin people={family.people} />}
        {visibleSection === "audit" && (
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
        {visibleSection === "backups" && backupAccess && <BackupAdmin archiveId={archiveContextAt(window.location.pathname)?.id || null} />}
        {visibleSection === "data" && (
          <section className="admin-card archive-form">
            <GedcomTransfer
              onImported={onChanged}
              save={save}
              canEdit={canEdit}
            />
          </section>
        )}
        {error && visibleSection !== "users" && (
          <p role="alert" className="form-error">
            {error}
          </p>
        )}
        {notice && visibleSection !== "users" && (
          <p className="admin-notice" role="status">
            {notice}
          </p>
        )}
      </div>
    </main>
  );
}
