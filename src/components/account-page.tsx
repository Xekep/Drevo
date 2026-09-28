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
import { ROLE_NAMES, fullName, type ArchiveUser, type Family } from "../domain";
import { clearLayoutStorage } from "./tree/layout-storage";
import "../styles/account.css";
import { LoginButtons } from "./login-buttons";

export type AccountSession = {
  user: ArchiveUser | null;
  local: boolean;
  yandex: boolean;
  vk?: boolean;
};
type SessionSummary = { currentExpiresAt: string | null; otherCount: number };

const date = (value?: string | null) => {
  if (!value || !Number.isFinite(Date.parse(value))) return null;
  return new Intl.DateTimeFormat("ru-RU", {
    day: "numeric",
    month: "long",
    year: "numeric",
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
}: {
  session: AccountSession | null;
  loading: boolean;
  error: boolean;
  family: Family | null;
  readTree: boolean;
  onPerson: (id: string) => void;
  onAdmin: () => void;
}) {
  const user = session?.user;
  const local = session?.local === true;
  const [sessions, setSessions] = useState<SessionSummary | null>(null);
  const [sessionError, setSessionError] = useState("");
  const [revoking, setRevoking] = useState(false);
  useEffect(() => {
    if (!user || local) return;
    const controller = new AbortController();
    fetch("/api/account/sessions", {
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
  }, [user, local]);
  const revokeOthers = async () => {
    setRevoking(true);
    setSessionError("");
    try {
      const response = await fetch("/api/account/sessions/revoke-others", {
        method: "POST",
      });
      if (!response.ok) throw new Error("Не удалось завершить другие сеансы");
      setSessions((previous) =>
        previous ? { ...previous, otherCount: 0 } : previous,
      );
    } catch {
      setSessionError(
        "Не удалось завершить другие сеансы. Попробуйте ещё раз.",
      );
    } finally {
      setRevoking(false);
    }
  };
  const logout = async () => {
    try {
      const response = await fetch("/auth/logout", { method: "POST" });
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
        ) : !user ? (
          <div className="account-card account-empty">
            <UserRound aria-hidden="true" />
            <h2>Войдите в Drevo</h2>
            <p>После входа здесь появятся ваш профиль и доступ к архиву.</p>
            <LoginButtons />
          </div>
        ) : user ? (
          <>
            <section className="account-hero" aria-labelledby="account-name">
              <div className="account-avatar" aria-hidden="true">
                {user.name.trim().charAt(0).toLocaleUpperCase("ru-RU") || "Д"}
              </div>
              <div className="account-identity">
                <span className="account-eyebrow">Участник Drevo</span>
                <h2 id="account-name">{user.name}</h2>
                <p>
                  {local
                    ? "Локальный доступ"
                    : user.id.startsWith("vk:")
                      ? "Вход через VK"
                      : "Вход через Яндекс"}
                  {date(user.createdAt) ? ` · с ${date(user.createdAt)}` : ""}
                </p>
              </div>
              <span
                className={`account-status ${user.approved ? "is-active" : ""}`}
              >
                {user.approved ? <Check size={16} /> : <Clock3 size={16} />}
                {user.approved ? "Доступ открыт" : "Ожидает подтверждения"}
              </span>
            </section>

            <div className="account-grid">
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
                  <div>
                    <span>Роль</span>
                    <strong>{ROLE_NAMES[user.role]}</strong>
                  </div>
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
                {!user.approved && (
                  <p className="account-note">
                    Администратор архива должен подтвердить ваш доступ. Профиль
                    и управление сеансами уже доступны.
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
                {user.role === "admin" && user.approved && (
                  <button className="account-row-action" onClick={onAdmin}>
                    Управление архивом <ArrowRight size={17} />
                  </button>
                )}
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
                        <span>Способ входа</span>
                        <strong>
                          Яндекс ID{" "}
                          <ExternalLink size={13} aria-hidden="true" />
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
                    {sessions && sessions.otherCount > 0 && (
                      <button
                        className="account-row-action"
                        disabled={revoking}
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
                    <button
                      className="account-signout"
                      onClick={() => void logout()}
                    >
                      <LogOut size={17} /> Выйти из этого сеанса
                    </button>
                  </>
                )}
              </section>

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
                  Сейчас Drevo использует общий семейный архив. Личные деревья и
                  экспорт своего дерева появятся после разделения архивов.
                </p>
                {user.role === "admin" && user.approved && (
                  <button className="account-row-action" onClick={onAdmin}>
                    <Users size={17} /> Управление и экспорт общего архива{" "}
                    <ArrowRight size={17} />
                  </button>
                )}
              </section>
            </div>
          </>
        ) : null}
      </div>
    </main>
  );
}
