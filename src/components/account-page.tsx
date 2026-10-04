import { archiveFetch } from "../data/archive-fetch.ts";
import { useEffect, useState } from "react";
import {
  ArrowRight,
  BookOpenText,
  Check,
  Clock3,
  ExternalLink,
  LogOut,
  ShieldCheck,
  TreeDeciduous,
  UserRound,
  Users,
} from "lucide-react";
import {
  ROLE_NAMES,
  isArchiveOwner,
  fullName,
  type ArchiveUser,
  type Family,
  type Role,
} from "../domain";
import { clearLayoutStorage } from "./tree/layout-storage";
import { archiveResourceUrl } from "../domain/archive-context.ts";
import "../styles/account.css";
import { LoginButtons } from "./login-buttons";
import { AccountAiHistory } from "./account-ai-history";
import { AccountEmailLink } from "./account-email-link";
import { AccountPasswordChange } from "./account-password-change";
import { PortableImport } from "./portable-import";
import { AccountOwnerTransfer } from "./account-owner-transfer";
import { AccountArchiveDeletion } from "./account-archive-deletion";
import { AccountSelfDeletion } from "./account-self-deletion";
import { CreatePersonalArchive } from "./create-personal-archive";
import { PlatformStaffRoles } from "./platform-staff-roles";
import { AiSettingsAdmin } from "./ai-settings-admin";
import { McpTokenAdmin } from "./mcp-token-admin";

export type AccountSession = {
  user: ArchiveUser | null;
  account?: {
    id: string;
    name: string;
    createdAt: string;
    fullAccess: boolean;
    globalRole?: "admin" | "researcher" | null;
    provider: "vk" | "yandex" | "email" | null;
    providers?: ("vk" | "yandex" | "email")[];
  } | null;
  local: boolean;
  yandex: boolean;
  vk?: boolean;
  email?: boolean;
};
type SessionSummary = {
  currentExpiresAt: string | null;
  otherCount: number;
  items?: {
    id: string;
    isCurrent: boolean;
    createdAt: string | null;
    expiresAt: string;
  }[];
};
function loginMethods(account: AccountSession["account"], identityId: string) {
  const providers = account?.providers?.length
    ? account.providers
    : [account?.provider || (identityId.startsWith("vk:") ? "vk" : "yandex")];
  return providers
    .map((provider) =>
      provider === "email"
        ? "Почта"
        : provider === "vk"
          ? "VK ID"
          : "Яндекс ID",
    )
    .join(" · ");
}
type AccountArchive = {
  id: string;
  title: string;
  role: Role;
  approved: boolean;
  owned: boolean;
  current: boolean;
};
function ArchiveList({ archives }: { archives: AccountArchive[] }) {
  return (
    <div className="account-archive-list" aria-label="Доступные деревья">
      {archives.map((item) => (
        <div className="account-archive-row" key={item.id}>
          <span className="account-archive-name">
            <strong>{item.title}</strong>
            <small>{item.owned ? "Владелец архива" : ROLE_NAMES[item.role]}</small>
          </span>
          {item.current ? (
            <span className="account-archive-current">Открыто</span>
          ) : item.approved ? (
            <a href={`/a/${encodeURIComponent(item.id)}/tree`}>
              Открыть <ArrowRight size={15} />
            </a>
          ) : (
            <span className="account-archive-current">Ожидает доступа</span>
          )}
        </div>
      ))}
    </div>
  );
}
type Capacity =
  | { available: false }
  | { available: true; owned: false }
  | {
      available: true;
      owned: true;
      fullAccess: boolean;
      people: number;
      emptyArchive: boolean;
      peopleLimit: number;
      mediaBytes: number | null;
      mediaLimitBytes: number;
    };
const megabytes = (bytes: number) =>
  new Intl.NumberFormat("ru-RU", { maximumFractionDigits: 1 }).format(
    bytes / 1_000_000,
  );

const date = (value?: string | null) => {
  if (!value || !Number.isFinite(Date.parse(value))) return null;
  return new Intl.DateTimeFormat("ru-RU", {
    day: "numeric",
    month: "long",
    year: "numeric",
  }).format(new Date(value));
};
const dateTime = (value?: string | null) => {
  if (!value || !Number.isFinite(Date.parse(value))) return null;
  return new Intl.DateTimeFormat("ru-RU", {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(new Date(value));
};

export function AccountPage({
  session,
  loading,
  error,
  family,
  readTree,
  onPerson,
  onAdmin,
  onOwnPlatformRoleChanged,
}: {
  session: AccountSession | null;
  loading: boolean;
  error: boolean;
  family: Family | null;
  readTree: boolean;
  onPerson: (id: string) => void;
  onAdmin: () => void;
  onOwnPlatformRoleChanged: (role: "admin" | "researcher" | null) => void;
}) {
  const user = session?.user;
  const identity = user || session?.account;
  const accountId = identity?.id || "";
  const local = session?.local === true;
  const [sessions, setSessions] = useState<SessionSummary | null>(null);
  const [archives, setArchives] = useState<AccountArchive[] | null>(null);
  const [capacityState, setCapacityState] = useState<{
    key: string;
    result: Capacity;
  } | null>(null);
  const capacityKey = user ? `${user.id}:${String(user.fullAccess)}` : "";
  const capacity =
    capacityState?.key === capacityKey ? capacityState.result : null;
  const [sessionError, setSessionError] = useState("");
  const [revoking, setRevoking] = useState(false);
  const [revokingSessionId, setRevokingSessionId] = useState<string | null>(
    null,
  );
  useEffect(() => {
    if (!accountId || local) return;
    const controller = new AbortController();
    archiveFetch("/api/account/sessions", {
      cache: "no-store",
      signal: controller.signal,
    })
      .then((response) => {
        if (!response.ok) throw new Error("Не удалось загрузить сеансы");
        return response.json();
      })
      .then((result: SessionSummary) => setSessions(result))
      .catch(() => {
        if (!controller.signal.aborted)
          setSessionError("Не удалось загрузить сеансы. Обновите страницу.");
      });
    return () => controller.abort();
  }, [accountId, local]);
  useEffect(() => {
    if (!accountId || local) return;
    const controller = new AbortController();
    void archiveFetch("/api/account/archives", {
      cache: "no-store",
      signal: controller.signal,
    })
      .then((response) => (response.ok ? response.json() : null))
      .then((result: { archives?: AccountArchive[] } | null) => {
        if (result && Array.isArray(result.archives))
          setArchives(result.archives);
      })
      .catch(() => {});
    return () => controller.abort();
  }, [accountId, local]);
  useEffect(() => {
    if (!user || local || user.fullAccess === undefined) return;
    const controller = new AbortController();
    const key = `${user.id}:${String(user.fullAccess)}`;
    void archiveFetch("/api/account/capacity", {
      cache: "no-store",
      signal: controller.signal,
    })
      .then((response) => {
        if (!response.ok) throw new Error("Не удалось загрузить квоты");
        return response.json() as Promise<Capacity>;
      })
      .then((result) => setCapacityState({ key, result }))
      .catch(() => {
        if (!controller.signal.aborted)
          setCapacityState({ key, result: { available: false } });
      });
    return () => controller.abort();
  }, [user, local]);
  const revokeOthers = async () => {
    setRevoking(true);
    setSessionError("");
    try {
      const response = await archiveFetch(
        "/api/account/sessions/revoke-others",
        {
          method: "POST",
        },
      );
      if (!response.ok) throw new Error("Не удалось завершить другие сеансы");
      setSessions((previous) =>
        previous
          ? {
              ...previous,
              otherCount: 0,
              items: previous.items?.filter((item) => item.isCurrent),
            }
          : previous,
      );
    } catch {
      setSessionError(
        "Не удалось завершить другие сеансы. Попробуйте ещё раз.",
      );
    } finally {
      setRevoking(false);
    }
  };
  const revokeOne = async (id: string) => {
    setRevokingSessionId(id);
    setSessionError("");
    try {
      const response = await archiveFetch(
        `/api/account/sessions/${encodeURIComponent(id)}/revoke`,
        { method: "POST" },
      );
      if (!response.ok) throw new Error("Не удалось завершить сеанс");
      const refreshed = await archiveFetch("/api/account/sessions", {
        cache: "no-store",
      });
      if (!refreshed.ok) throw new Error("Не удалось обновить список сеансов");
      setSessions((await refreshed.json()) as SessionSummary);
    } catch {
      setSessionError("Не удалось завершить сеанс. Попробуйте ещё раз.");
    } finally {
      setRevokingSessionId(null);
    }
  };
  const logout = async () => {
    try {
      const response = await archiveFetch("/auth/logout", { method: "POST" });
      if (response.ok) await clearLayoutStorage();
    } finally {
      window.location.replace("/");
    }
  };
  const person = user?.personId
    ? family?.people.find((entry) => entry.id === user.personId)
    : undefined;

  return (
    <main className="account-page">
      <div className="account-shell">
        <div className="account-heading">
          <div>
            <span className="account-eyebrow">Ваше пространство</span>
            <h1>Личный кабинет</h1>
            <p>Профиль, доступ к семейному архиву и настройки просмотра.</p>
          </div>
          {identity && (
            <a className="account-row-action" href="/discover">
              <Users size={17} aria-hidden="true" /> Поиск опубликованных людей
            </a>
          )}
        </div>
        {loading ? (
          <div className="account-card account-empty" role="status">
            Загружаем профиль…
          </div>
        ) : error ? (
          <div className="account-card account-empty" role="alert">
            <h2>Не удалось загрузить профиль</h2>
            <p>Проверьте соединение и попробуйте ещё раз.</p>
            <button
              className="account-primary"
              onClick={() => window.location.reload()}
            >
              Обновить страницу <ArrowRight size={17} />
            </button>
          </div>
        ) : !identity ? (
          <div className="account-card account-empty">
            <UserRound aria-hidden="true" />
            <h2>Войдите в Drevo</h2>
            <p>После входа здесь появятся ваш профиль и доступ к архиву.</p>
            <LoginButtons />
          </div>
        ) : identity ? (
          <>
            <section className="account-hero" aria-labelledby="account-name">
              <div className="account-avatar" aria-hidden="true">
                {identity.name.trim().charAt(0).toLocaleUpperCase("ru-RU") ||
                  "Д"}
              </div>
              <div className="account-identity">
                <span className="account-eyebrow">Участник Drevo</span>
                <h2 id="account-name">{identity.name}</h2>
                <p>
                  {local
                    ? "Локальный доступ"
                    : loginMethods(session?.account, identity.id)}
                  {date(identity.createdAt)
                    ? ` · с ${date(identity.createdAt)}`
                    : ""}
                </p>
              </div>
              <span
                className={`account-status ${!user || user.approved ? "is-active" : ""}`}
              >
                {!user || user.approved ? (
                  <Check size={16} />
                ) : (
                  <Clock3 size={16} />
                )}
                {!user
                  ? "Аккаунт активен"
                  : user.approved
                    ? "Доступ открыт"
                    : "Ожидает подтверждения"}
              </span>
            </section>

            <div className="account-grid">
              {user ? (
                <section
                  className="account-card"
                  aria-labelledby="account-access-title"
                >
                  <div className="account-card-title">
                    <span className="account-icon">
                      <TreeDeciduous size={20} />
                    </span>
                    <div>
                      <span className="account-eyebrow">Семейный архив</span>
                      <h2 id="account-access-title">Доступ и роль</h2>
                    </div>
                  </div>
                  <div className="account-facts">
                    {user.fullAccess !== undefined && (
                      <div>
                        <span>Уровень аккаунта</span>
                        <strong>
                          {(
                            capacity?.available && capacity.owned
                              ? capacity.fullAccess
                              : user.fullAccess
                          )
                            ? "Полный"
                            : "Базовый"}
                        </strong>
                      </div>
                    )}
                    <div>
                      <span>Роль</span>
                      <strong>{isArchiveOwner(user) ? "Владелец архива" : ROLE_NAMES[user.treeRole || user.role]}</strong>
                    </div>
                    {capacity?.available && capacity.owned && (
                      <>
                        <div>
                          <span>Людей в этом дереве</span>
                          <strong>
                            {capacity.people.toLocaleString("ru-RU")}
                            {capacity.fullAccess
                              ? ""
                              : ` из ${capacity.peopleLimit}`}
                          </strong>
                        </div>
                        <div>
                          <span>Фото и документы</span>
                          <strong>
                            {capacity.mediaBytes === null
                              ? "Объём уточняется"
                              : `${megabytes(capacity.mediaBytes)} МБ${capacity.fullAccess ? "" : ` из ${megabytes(capacity.mediaLimitBytes)} МБ`}`}
                          </strong>
                        </div>
                      </>
                    )}
                    <div>
                      <span>Доступ к древу</span>
                      <strong>
                        {!user.approved
                          ? "Ожидает подтверждения"
                          : family && !readTree
                            ? "Нет доступа"
                            : user.treeAccess === "common_ancestors"
                              ? "Общие предки"
                              : "По роли в архиве"}
                      </strong>
                    </div>
                    <div>
                      <span>Карточка в древе</span>
                      <strong>
                        {person
                          ? fullName(person)
                          : user.personId
                            ? "Недоступна для просмотра"
                            : "Не привязана"}
                      </strong>
                    </div>
                  </div>
                  {archives && archives.length > 1 && (
                    <div className="account-archive-summary">
                      <h3>Мои деревья</h3>
                      <ArchiveList archives={archives} />
                    </div>
                  )}
                  {archives &&
                    !archives.some((item) => item.owned) &&
                    !local && <CreatePersonalArchive />}
                  {!user.approved && (
                    <p className="account-note">
                      Администратор архива должен подтвердить ваш доступ.
                      Профиль и управление сеансами уже доступны.
                    </p>
                  )}
                  {person && (
                    <button
                      className="account-row-action"
                      onClick={() => onPerson(person.id)}
                    >
                      Открыть мою карточку <ArrowRight size={17} />
                    </button>
                  )}
                  {isArchiveOwner(user) && user.approved && (
                    <button className="account-row-action" onClick={onAdmin}>
                      Управление архивом <ArrowRight size={17} />
                    </button>
                  )}
                </section>
              ) : (
                <section
                  className="account-card"
                  aria-labelledby="account-archives-title"
                >
                  <div className="account-card-title">
                    <span className="account-icon">
                      <TreeDeciduous size={20} />
                    </span>
                    <div>
                      <span className="account-eyebrow">Семейный архив</span>
                      <h2 id="account-archives-title">Мои деревья</h2>
                    </div>
                  </div>
                  <div className="account-facts">
                    <div>
                      <span>Уровень аккаунта</span>
                      <strong>
                        {session?.account?.fullAccess ? "Полный" : "Базовый"}
                      </strong>
                    </div>
                  </div>
                  {archives === null ? (
                    <p className="account-card-copy">Загружаем деревья…</p>
                  ) : archives.length ? (
                    <>
                      <ArchiveList archives={archives} />
                      {!archives.some((item) => item.owned) && !local && (
                        <CreatePersonalArchive />
                      )}
                    </>
                  ) : (
                    <>
                      <p className="account-card-copy">
                        Пока нет доступных деревьев.
                      </p>
                      {!local && session?.account && <CreatePersonalArchive />}
                    </>
                  )}
                </section>
              )}

              <section
                className="account-card"
                aria-labelledby="account-security-title"
              >
                <div className="account-card-title">
                  <span className="account-icon">
                    <ShieldCheck size={20} />
                  </span>
                  <div>
                    <span className="account-eyebrow">Безопасность</span>
                    <h2 id="account-security-title">Вход и сеансы</h2>
                  </div>
                </div>
                {local ? (
                  <p className="account-card-copy">
                    Вы работаете в локальном режиме без отдельного аккаунта и
                    сеансов входа.
                  </p>
                ) : (
                  <>
                    <div className="account-facts">
                      <div>
                        <span>Способы входа</span>
                        <strong>
                          {loginMethods(session?.account, identity.id)}
                        </strong>
                      </div>
                      <div>
                        <span>Этот сеанс</span>
                        <strong>
                          {date(sessions?.currentExpiresAt)
                            ? `До ${date(sessions?.currentExpiresAt)}`
                            : "Активен"}
                        </strong>
                      </div>
                      <div>
                        <span>Другие сеансы</span>
                        <strong>
                          {sessions ? sessions.otherCount : "Загружаем…"}
                        </strong>
                      </div>
                    </div>
                    {sessions?.items && (
                      <div
                        className="account-session-list"
                        aria-label="Активные сеансы"
                      >
                        {sessions.items.map((item) => (
                          <div className="account-session-item" key={item.id}>
                            <div>
                              <strong>
                                {item.isCurrent ? "Этот сеанс" : "Другой сеанс"}
                              </strong>
                              <span>
                                {item.createdAt
                                  ? `Вход ${dateTime(item.createdAt)}`
                                  : "Дата входа неизвестна"}
                              </span>
                            </div>
                            {item.isCurrent ? (
                              <button
                                className="account-session-revoke"
                                onClick={() => void logout()}
                              >
                                Выйти
                              </button>
                            ) : (
                              <button
                                className="account-session-revoke"
                                disabled={
                                  revoking || revokingSessionId !== null
                                }
                                onClick={() => void revokeOne(item.id)}
                              >
                                {revokingSessionId === item.id
                                  ? "Завершаем…"
                                  : "Завершить"}
                              </button>
                            )}
                          </div>
                        ))}
                        {sessions.otherCount > 20 && (
                          <p className="account-session-more">
                            Показаны последние 20 других сеансов. Остальные
                            можно завершить кнопкой ниже.
                          </p>
                        )}
                      </div>
                    )}
                    {sessions && sessions.otherCount > 0 && (
                      <button
                        className="account-row-action"
                        disabled={revoking || revokingSessionId !== null}
                        onClick={() => void revokeOthers()}
                      >
                        {revoking ? "Завершаем…" : "Завершить другие сеансы"}{" "}
                        <ArrowRight size={17} />
                      </button>
                    )}
                    {sessionError && (
                      <p className="account-error" role="alert">
                        {sessionError}
                      </p>
                    )}
                    {session?.email === true &&
                      (session.account?.providers?.includes("email") === true ||
                        session.account?.provider === "email") && (
                        <AccountPasswordChange
                          onChanged={() =>
                            setSessions((previous) =>
                              previous
                                ? {
                                    ...previous,
                                    otherCount: 0,
                                    items: previous.items?.filter(
                                      (item) => item.isCurrent,
                                    ),
                                  }
                                : previous,
                            )
                          }
                        />
                      )}
                    <AccountEmailLink
                      linked={
                        session?.account?.providers?.includes("email") ===
                          true || session?.account?.provider === "email"
                      }
                    />
                    {session?.account && (
                      <div className="account-export-actions">
                        <p className="account-card-copy">
                          Скачайте сведения об аккаунте, способах входа, доступе
                          к архивам, настройках и свои текущие комментарии в
                          доступных частях деревьев. Тексты из закрытых ветвей и
                          архивов без действующего доступа в файл не входят.
                        </p>
                        <a
                          className="account-row-action"
                          href="/api/account/export"
                          download="drevo-account.json"
                        >
                          Скачать данные аккаунта
                          <ExternalLink size={16} aria-hidden="true" />
                        </a>
                        <a
                          className="account-row-action"
                          href="/api/account/export/attachments"
                          download="drevo-account-attachments.zip"
                        >
                          Скачать свои вложения обсуждений и ИИ-диалогов
                          <ExternalLink size={16} aria-hidden="true" />
                        </a>
                        <p className="account-card-copy">
                          ИИ-диалоги и их вложения входят в экспорт только при действующем доступе к ИИ в этом дереве.
                        </p>
                      </div>
                    )}
                    <button
                      className="account-signout"
                      onClick={() => void logout()}
                    >
                      <LogOut size={17} /> Выйти из этого сеанса
                    </button>
                    <AccountSelfDeletion />
                  </>
                )}
              </section>

              {user && (
                <section
                  className="account-card"
                  aria-labelledby="account-data-title"
                >
                  <div className="account-card-title">
                    <span className="account-icon">
                      <BookOpenText size={20} />
                    </span>
                    <div>
                      <span className="account-eyebrow">Данные</span>
                      <h2 id="account-data-title">Сведения архива</h2>
                    </div>
                  </div>
                  <p className="account-card-copy">
                    Сведения и экспорт выбранного дерева доступны в пределах
                    вашей роли.
                  </p>
                  {capacity?.available &&
                    capacity.owned &&
                    isArchiveOwner(user) &&
                    user.approved && (
                      <div className="account-export-actions">
                        <a
                          className="account-row-action"
                          href={archiveResourceUrl("/api/drevo/export")}
                          download="drevo.drevo"
                        >
                          Скачать полный переносимый архив (.drevo)
                          <ExternalLink size={16} aria-hidden="true" />
                        </a>
                        <a
                          className="account-row-action"
                          href={archiveResourceUrl(
                            "/api/gedcom/export?format=gedzip7",
                          )}
                          download="drevo.gdz"
                        >
                          Скачать дерево с фото и документами (GEDZIP)
                          <ExternalLink size={16} aria-hidden="true" />
                        </a>
                        <a
                          className="account-row-action"
                          href={archiveResourceUrl(
                            "/api/gedcom/export?format=gedcom7",
                          )}
                          download="drevo-7.ged"
                        >
                          Скачать данные дерева (GEDCOM 7)
                          <ExternalLink size={16} aria-hidden="true" />
                        </a>
                      </div>
                    )}
                  {capacity?.available &&
                    capacity.owned &&
                    isArchiveOwner(user) &&
                    user.approved &&
                    capacity.emptyArchive && <PortableImport />}
                  {capacity?.available && user.approved && (
                    <AccountOwnerTransfer key={window.location.pathname} />
                  )}
                  {capacity?.available &&
                    capacity.owned &&
                    user.approved &&
                    window.location.pathname.startsWith("/a/") && (
                      <AccountArchiveDeletion key={window.location.pathname} />
                    )}
                  {isArchiveOwner(user) && user.approved && (
                    <button className="account-row-action" onClick={onAdmin}>
                      <Users size={17} /> Управление архивом{" "}
                      <ArrowRight size={17} />
                    </button>
                  )}
                </section>
              )}
              {session?.account?.globalRole === "admin" && (
                <>
                  <PlatformStaffRoles currentAccountId={accountId}
                    onOwnRoleChanged={onOwnPlatformRoleChanged} />
                  <AiSettingsAdmin />
                  {user?.approved && isArchiveOwner(user) && <McpTokenAdmin />}
                </>
              )}
              {user?.approved && (
                <AccountAiHistory key={accountId} accountId={accountId} />
              )}
            </div>
          </>
        ) : null}
      </div>
    </main>
  );
}
