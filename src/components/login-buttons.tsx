import { useEffect, useState, type FormEvent } from "react";
import { markEntrySequence } from "./entry-sequence";
import "../styles/login-buttons.css";

type Providers = { vk: boolean; yandex: boolean; email: boolean };
type EmailMode = "login" | "register" | "request-reset" | "reset" | "verify" | "link";
function initialEmailLink() {
  if (typeof window === "undefined") return null;
  const match = /^#email-(verify|reset|link)=([A-Za-z0-9_-]{43})$/.exec(
    window.location.hash,
  );
  return match
    ? {
        mode: match[1] as EmailMode,
        token: match[2],
      }
    : null;
}
export function LoginButtons({
  onBeforeNavigate,
}: { onBeforeNavigate?: () => void } = {}) {
  const [providers, setProviders] = useState<Providers | null>(null);
  const [failed, setFailed] = useState(false);
  const [mode, setMode] = useState<EmailMode | null>(
    () => initialEmailLink()?.mode || null,
  );
  const [email, setEmail] = useState("");
  const [name, setName] = useState("");
  const [password, setPassword] = useState("");
  const [token] = useState(() => initialEmailLink()?.token || "");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  useEffect(() => {
    const controller = new AbortController();
    if (initialEmailLink()) {
      window.history.replaceState(
        window.history.state,
        "",
        window.location.pathname + window.location.search,
      );
    }
    fetch("/api/session", {
      cache: "no-store",
      signal: controller.signal,
    })
      .then(async (response) => {
        if (!response.ok) throw new Error("Session unavailable");
        const data = await response.json();
        if (!controller.signal.aborted)
          setProviders({
            vk: data.vk === true,
            yandex: data.yandex === true,
            email: data.email === true,
          });
      })
      .catch(() => {
        if (!controller.signal.aborted) setFailed(true);
      });
    return () => controller.abort();
  }, []);

  async function submitEmail(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!mode || busy) return;
    setBusy(true);
    setError("");
    setMessage("");
    const path =
      mode === "verify"
        ? "verify"
        : mode === "link"
          ? "link/verify"
        : mode === "request-reset"
          ? "reset/request"
          : mode === "reset"
            ? "reset/complete"
            : mode;
    try {
      const response = await fetch(`/api/auth/email/${path}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email, name, password, token }),
      });
      const result = await response.json();
      if (!response.ok)
        throw new Error(result.error || "Не удалось выполнить запрос.");
      if (result.archiveId) {
        onBeforeNavigate?.();
        markEntrySequence();
        window.location.replace(`/a/${result.archiveId}/tree`);
        return;
      }
      if (result.account) {
        window.location.replace("/account");
        return;
      }
      if (result.linked) {
        window.location.replace("/account");
        return;
      }
      setMessage(result.message || "Готово.");
      setPassword("");
      if (mode === "reset") setMode("login");
    } catch (cause) {
      setError(
        cause instanceof Error ? cause.message : "Не удалось выполнить запрос.",
      );
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="login-providers">
      <a href="/discover">Поиск опубликованных людей</a>
      <div
        className="login-provider-buttons"
        role="group"
        aria-label="Способ входа"
      >
        {(["vk", "yandex"] as const).map((provider) => {
          if (!providers?.[provider]) return null;
          const label = provider === "vk" ? "VK" : "Яндекс";
          return (
            <button
              key={provider}
              type="button"
              className={`login-provider login-provider-${provider}`}
              aria-label={`Войти через ${label}`}
              title={`Войти через ${label}`}
              onClick={() => {
                onBeforeNavigate?.();
                markEntrySequence();
                window.location.assign(`/auth/${provider}`);
              }}
            >
              {provider === "vk" ? (
                <svg viewBox="0 0 24 24" aria-hidden="true">
                  <path
                    fill="currentColor"
                    d="M12.785 16.241c-4.1 0-6.439-2.81-6.536-7.488h2.054c.067 3.434 1.581 4.889 2.78 5.189V8.753h1.934v2.962c1.185-.127 2.43-1.477 2.85-2.962h1.934c-.323 1.829-1.673 3.179-2.633 3.734.96.45 2.497 1.627 3.082 3.754h-2.13c-.457-1.417-1.596-2.512-3.103-2.662v2.662z"
                  />
                </svg>
              ) : (
                <svg viewBox="0 0 24 24" aria-hidden="true">
                  <path
                    fill="currentColor"
                    d="M15.85 3H12.2C8.54 3 6.6 4.88 6.6 7.65c0 2.21 1.04 3.55 2.91 4.89L6.3 21h3.14l3.59-9.48-1.56-1.05c-1.39-.94-2.04-1.67-2.04-2.97 0-1.5.98-2.43 2.84-2.43h.74V21h2.84z"
                  />
                </svg>
              )}
            </button>
          );
        })}
        {providers?.email && (
          <button
            type="button"
            className="login-provider login-provider-email"
            title="Войти по почте"
            aria-label="Войти по почте"
            onClick={() => {
              setMode(mode ? null : "login");
              setError("");
              setMessage("");
            }}
          >
            <svg viewBox="0 0 24 24" aria-hidden="true">
              <path
                fill="currentColor"
                d="M3 5h18a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2zm0 3v.4l9 6 9-6V8l-9 6-9-6zm0 2.8V17h18v-6.2l-9 6-9-6z"
              />
            </svg>
          </button>
        )}
      </div>
      {providers?.email && mode && (
        <form
          className="login-email-form"
          onSubmit={(event) => void submitEmail(event)}
        >
          <h3>
            {mode === "register"
              ? "Создать личное древо"
              : mode === "request-reset"
                ? "Восстановить доступ"
                : mode === "reset"
                  ? "Новый пароль"
                  : mode === "verify"
                    ? "Подтвердить почту"
                    : mode === "link"
                      ? "Подключить почту"
                    : "Вход по почте"}
          </h3>
          {mode === "link" && <p>Подтвердите подключение почты к аккаунту, в который вы сейчас вошли. Если сеанс завершился, войдите снова и откройте ссылку из письма.</p>}
          {mode === "register" && (
            <label>
              Имя
              <input
                autoComplete="name"
                value={name}
                onChange={(event) => setName(event.target.value)}
                required
                maxLength={160}
              />
            </label>
          )}
          {(mode === "register" ||
            mode === "login" ||
            mode === "request-reset") && (
            <label>
              Почта
              <input
                type="email"
                autoComplete="email"
                value={email}
                onChange={(event) => setEmail(event.target.value)}
                required
                maxLength={254}
              />
            </label>
          )}
          {(mode === "register" || mode === "login" || mode === "reset") && (
            <label>
              Пароль
              <input
                type="password"
                autoComplete={
                  mode === "login" ? "current-password" : "new-password"
                }
                value={password}
                onChange={(event) => setPassword(event.target.value)}
                required
                minLength={mode === "login" ? undefined : 12}
                aria-describedby={mode === "login" ? undefined : "new-password-help"}
              />
              {mode !== "login" && <small id="new-password-help">Не менее 12 символов</small>}
            </label>
          )}
          {message && <p role="status">{message}</p>}
          {error && <p role="alert">{error}</p>}
          <button type="submit" disabled={busy}>
            {busy
              ? "Подождите…"
              : mode === "register"
                ? "Зарегистрироваться"
                : mode === "request-reset"
                  ? "Отправить ссылку"
                  : mode === "reset"
                    ? "Сменить пароль"
                    : mode === "verify"
                      ? "Подтвердить"
                      : mode === "link"
                        ? "Подключить почту"
                      : "Войти"}
          </button>
          {mode !== "link" && <div className="login-email-options">
            {mode !== "login" && (
              <button
                type="button"
                onClick={() => {
                  setMode("login");
                  setError("");
                  setMessage("");
                }}
              >
                Войти
              </button>
            )}
            {mode !== "register" && (
              <button
                type="button"
                onClick={() => {
                  setMode("register");
                  setError("");
                  setMessage("");
                }}
              >
                Создать аккаунт
              </button>
            )}
            {mode !== "request-reset" && (
              <button
                type="button"
                onClick={() => {
                  setMode("request-reset");
                  setError("");
                  setMessage("");
                }}
              >
                Забыли пароль?
              </button>
            )}
          </div>}
        </form>
      )}
      {failed ? (
        <p role="alert">
          Не удалось загрузить способы входа. Обновите страницу.
        </p>
      ) : providers &&
        !providers.vk &&
        !providers.yandex &&
        !providers.email ? (
        <p>Вход пока недоступен.</p>
      ) : !providers ? (
        <span role="status">Загружаем способы входа…</span>
      ) : null}
    </div>
  );
}
