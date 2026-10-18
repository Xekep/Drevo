import type { AccountSession } from "../shared/account-session.ts";
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
  type Family,
  type Role,
} from "../domain";
import { clearLayoutStorage } from "./tree/layout-storage";
import {
  archiveResourceUrl,
  scopedArchivePath,
} from "../domain/archive-context.ts";
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

export type { AccountSession } from "../shared/account-session.ts";

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
  href: string;
};
function ArchiveList({ archives }: { archives: AccountArchive[] }) {
  return (
    <div className="account-archive-list" aria-label="Доступные древа">
      {archives.map((item) => (
        <div className="account-archive-row" key={item.id}>
          <span className="account-archive-name">
            <strong>{item.title}</strong>
            <small>
              {item.owned ? "Владелец архива" : ROLE_NAMES[item.role]}
            </small>
          </span>
          {item.current && (
            <span className="account-archive-current">Выбрано</span>
          )}
          {item.approved ? (
            <a
              href={item.href}
              aria-label={`Открыть древо «${item.title}»`}
            >
              Открыть <ArrowRight size={15} aria-hidden="true" />
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
  onPlatformAdmin,
}: {
  session: AccountSession | null;
  loading: boolean;
  error: boolean;
  family: Family | null;
  readTree: boolean;
  onPerson: (id: string) => void;
  onAdmin: () => void;
  onPlatformAdmin: () => void;
}) {
  const user = session?.user;
  const identity = user || session?.account;
  const accountId = identity?.id || "";
  const local = session?.local === true;
  const [sessions, setSessions] = useState<SessionSummary | null>(null);
  const [archives, setArchives] = useState<AccountArchive[] | null>(null);
  const [archivesError, setArchivesError] = useState("");
  const [archivesAttempt, setArchivesAttempt] = useState(0);
  const [loggingOut, setLoggingOut] = useState(false);
  useEffect(() => {
    document.title = "Личный кабинет · Семейный архив";
  }, []);
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
      .then((response) => {
        if (!response.ok) throw new Error("Не удалось загрузить древа");
        return response.json();
      })
      .then((result: { archives?: AccountArchive[] } | null) => {
        if (
          !controller.signal.aborted &&
          result &&
          Array.isArray(result.archives)
        )
          setArchives(result.archives);
      })
      .catch(() => {
        if (!controller.signal.aborted)
          setArchivesError(
            "Не удалось загрузить древа. Проверьте соединение и повторите попытку.",
          );
      });
    return () => controller.abort();
  }, [accountId, local, archivesAttempt]);
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
    if (loggingOut) return;
    setLoggingOut(true);
    setSessionError("");
    try {
      const response = await archiveFetch("/auth/logout", { method: "POST" });
      if (!response.ok) throw new Error("Выход не выполнен");
      await clearLayoutStorage().catch(() => {});
      window.location.replace("/");
    } catch {
      setSessionError(
        "Не удалось выйти. Проверьте соединение и нажмите «Выйти из этого сеанса» ещё раз.",
      );
      setLoggingOut(false);
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
            <p>Древа, безопасность аккаунта и личные данные.</p>
          </div>
          <div className="account-heading-actions">
            {(session?.account?.globalRole === "admin" ||
              (!session?.account && user?.platformAdmin === true)) && (
              <button className="account-row-action" onClick={onPlatformAdmin}>
                <ShieldCheck size={17} aria-hidden="true" /> Админка платформы
              </button>
            )}
            {identity && (
              <a className="account-row-action" href="/discover">
                <Users size={17} aria-hidden="true" /> Поиск опубликованных
                людей
              </a>
            )}
          </div>
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
              <div className="account-identity-status">
                {(session?.account?.fullAccess !== undefined ||
                  user?.fullAccess !== undefined) && (
                  <span className="account-tier">
                    {(session?.account?.fullAccess ?? user?.fullAccess)
                      ? "Полный аккаунт"
                      : "Базовый аккаунт"}
                  </span>
                )}
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
              </div>
            </section>
            <nav
              className="account-section-links"
              aria-label="Разделы личного кабинета"
            >
              <a href="#account-archives-title">Мои древа</a>
              <a href="#account-security-title">Безопасность</a>
              {!local && session?.account && (
                <a href="#account-personal-data-title">Личные данные</a>
              )}
            </nav>
            <div className="account-grid">
              <section
                className="account-card account-card-wide account-trees-card"
                aria-labelledby="account-archives-title"
              >
                <div className="account-card-title">
                  <span className="account-icon">
                    <TreeDeciduous size={20} aria-hidden="true" />
                  </span>
                  <div>
                    <h2 id="account-archives-title">Мои древа</h2>
                    <p className="account-card-copy">
                      Откройте древо или проверьте доступ к выбранному архиву.
                    </p>
                  </div>
                </div>
                <div
                  className={`account-trees-layout${user ? " has-selection" : ""}`}
                >
                  <div>
                    {local && family ? (
                      <ArchiveList
                        archives={[
                          {
                            id: "local",
                            title: family.title,
                            role: user?.role || "reader",
                            approved: true,
                            owned: !!user && isArchiveOwner(user),
                            current: true,
                            href: scopedArchivePath("/tree"),
                          },
                        ]}
                      />
                    ) : archivesError ? (
                      <div className="account-load-error" role="alert">
                        <p>{archivesError}</p>
                        <button
                          type="button"
                          className="account-row-action"
                          onClick={() => {
                            setArchivesError("");
                            setArchives(null);
                            setArchivesAttempt((value) => value + 1);
                          }}
                        >
                          Повторить загрузку древ
                        </button>
                      </div>
                    ) : archives === null ? (
                      <p role="status" className="account-card-copy">
                        Загружаем древа…
                      </p>
                    ) : archives.length ? (
                      <ArchiveList archives={archives} />
                    ) : (
                      <p className="account-card-copy">
                        Пока нет доступных древ. Создайте своё или откройте
                        приглашение от родственника.
                      </p>
                    )}
                    {archives &&
                      !archives.some((item) => item.owned) &&
                      !local && <CreatePersonalArchive />}
                  </div>
                  {user && (
                    <div className="account-selected-tree">
                      <div className="account-selected-heading">
                        <span className="account-eyebrow">Выбранное древо</span>
                        <h3>
                          {family?.title ||
                            archives?.find((item) => item.current)?.title ||
                            "Семейный архив"}
                        </h3>
                      </div>
                      <h4 id="account-access-title">Доступ и роль</h4>
                      <div className="account-facts">
                        <div>
                          <span>Роль</span>
                          <strong>
                            {isArchiveOwner(user)
                              ? "Владелец архива"
                              : ROLE_NAMES[user.treeRole || user.role]}
                          </strong>
                        </div>
                        {capacity?.available && capacity.owned && (
                          <>
                            <div>
                              <span>Людей в этом древе</span>
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
                                  ? "Кровные родственники"
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

                      {!user.approved && (
                        <p className="account-note">
                          Владелец древа должен подтвердить ваш доступ.
                          Настройки аккаунта уже доступны.
                        </p>
                      )}
                      <div className="account-tree-actions">
                        {person && (
                          <button
                            className="account-row-action"
                            onClick={() => onPerson(person.id)}
                          >
                            Открыть мою карточку{" "}
                            <ArrowRight size={17} aria-hidden="true" />
                          </button>
                        )}
                        {isArchiveOwner(user) && user.approved && (
                          <a
                            className="account-row-action"
                            href={scopedArchivePath("/manage")}
                            onClick={(event) => {
                              if (
                                event.button !== 0 ||
                                event.ctrlKey ||
                                event.metaKey ||
                                event.shiftKey ||
                                event.altKey
                              )
                                return;
                              event.preventDefault();
                              onAdmin();
                            }}
                          >
                            Управление древом{" "}
                            <ArrowRight size={17} aria-hidden="true" />
                          </a>
                        )}
                      </div>
                      {user.approved && (
                        <details className="account-tree-data">
                          <summary id="account-data-title">
                            Данные и владение древом
                          </summary>
                          <p className="account-card-copy">
                            Экспорт выбранного древа доступен в пределах вашей
                            роли.
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
                                  Скачать древо с фото и документами (GEDZIP)
                                  <ExternalLink size={16} aria-hidden="true" />
                                </a>
                                <a
                                  className="account-row-action"
                                  href={archiveResourceUrl(
                                    "/api/gedcom/export?format=gedcom7",
                                  )}
                                  download="drevo-7.ged"
                                >
                                  Скачать данные древа (GEDCOM 7)
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
                            <AccountOwnerTransfer
                              key={window.location.pathname}
                            />
                          )}
                          {capacity?.available &&
                            capacity.owned &&
                            user.approved &&
                            window.location.pathname.startsWith("/a/") && (
                              <AccountArchiveDeletion
                                key={window.location.pathname}
                              />
                            )}
                        </details>
                      )}
                    </div>
                  )}
                </div>
              </section>

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
                                disabled={loggingOut}
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
                    <button
                      className="account-signout"
                      disabled={loggingOut}
                      onClick={() => void logout()}
                    >
                      <LogOut size={17} aria-hidden="true" />{" "}
                      {loggingOut ? "Выходим…" : "Выйти из этого сеанса"}
                    </button>
                  </>
                )}
              </section>

              {!local && session?.account && (
                <section
                  className="account-card"
                  aria-labelledby="account-personal-data-title"
                >
                  <div className="account-card-title">
                    <span className="account-icon">
                      <BookOpenText size={20} aria-hidden="true" />
                    </span>
                    <div>
                      <h2 id="account-personal-data-title">Личные данные</h2>
                    </div>
                  </div>
                  {session?.account && (
                    <div className="account-export-actions">
                      <p className="account-card-copy">
                        Скачайте сведения об аккаунте, способах входа, доступе к
                        архивам, настройках и свои текущие комментарии в
                        доступных частях древ. Тексты из закрытых ветвей и
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
                        ИИ-диалоги и их вложения входят в экспорт только при
                        действующем доступе к ИИ в этом древе.
                      </p>
                    </div>
                  )}

                  <details className="account-danger-zone">
                    <summary>Удаление аккаунта</summary>
                    <AccountSelfDeletion />
                  </details>
                </section>
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
