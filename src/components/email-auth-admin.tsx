import { useEffect, useState } from "react";
import { useUnsavedChanges } from "../hooks/useUnsavedChanges";
import type { EmailAuthStatus } from "../shared/email-auth-settings";
import "../styles/vk-auth-admin.css";
import "../styles/email-auth-admin.css";

export function EmailAuthAdmin({
  onDirtyChange,
}: {
  onDirtyChange?: (dirty: boolean) => void;
}) {
  const [settings, setSettings] = useState<EmailAuthStatus | null>(null);
  const [password, setPassword] = useState("");
  const [removePassword, setRemovePassword] = useState(false);
  const [recipient, setRecipient] = useState("");
  const [savedSettings, setSavedSettings] = useState<EmailAuthStatus | null>(
    null,
  );
  const dirty =
    !!settings &&
    !!savedSettings &&
    ((["enabled", "host", "port", "user", "from"] as const).some(
      (key) => settings[key] !== savedSettings[key],
    ) ||
      !!password ||
      removePassword);
  const [busy, setBusy] = useState<"save" | "test" | null>(null);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  useUnsavedChanges(dirty, onDirtyChange);
  useEffect(() => {
    const controller = new AbortController();
    // Global configuration always uses the primary platform endpoint.
    void fetch("/api/admin/auth/email", {
      cache: "no-store",
      signal: controller.signal,
    })
      .then(async (response) => {
        const data = await response.json();
        if (!response.ok)
          throw new Error(
            data.error || "Не удалось загрузить настройки почты.",
          );
        if (!controller.signal.aborted) {
          setSettings(data);
          setSavedSettings(data);
        }
      })
      .catch((reason) => {
        if (!controller.signal.aborted) setError(reason.message);
      });
    return () => controller.abort();
  }, []);
  function change(update: Partial<EmailAuthStatus>) {
    if (settings) setSettings({ ...settings, ...update });
    setMessage("");
    setError("");
  }
  async function submit(action: "save" | "test") {
    if (!settings || busy) return;
    setBusy(action);
    setError("");
    setMessage("");
    try {
      const response = await fetch(
        `/api/admin/auth/email${action === "test" ? "/test" : ""}`,
        {
          method: action === "save" ? "PUT" : "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(
            action === "test"
              ? { to: recipient }
              : {
                  enabled: settings.enabled,
                  host: settings.host,
                  port: settings.port,
                  user: settings.user,
                  from: settings.from,
                  ...(removePassword
                    ? { password: null }
                    : password
                      ? { password }
                      : {}),
                },
          ),
        },
      );
      const data = await response.json();
      if (!response.ok)
        throw new Error(data.error || "Не удалось выполнить запрос.");
      if (action === "save") {
        setSettings(data);
        setSavedSettings(data);
        setPassword("");
        setRemovePassword(false);
        setMessage(
          data.available
            ? "Сохранено. Вход по email включён."
            : "Сохранено. Вход по email выключен.",
        );
      } else setMessage(data.message);
    } catch (reason) {
      setError(
        reason instanceof Error
          ? reason.message
          : "Не удалось выполнить запрос.",
      );
    } finally {
      setBusy(null);
    }
  }
  return (
    <section
      className="admin-card vk-auth-settings email-auth-settings"
      aria-label="Настройки входа по email"
    >
      {settings ? (
        <>
          {!settings.supported && (
            <p className="field-help">
              Настройки доступны на сервере с PostgreSQL.
            </p>
          )}
          <form
            onSubmit={(event) => {
              event.preventDefault();
              void submit("save");
            }}
          >
            <fieldset disabled={!!busy || !settings.supported}>
              <label className="check-row">
                <input
                  type="checkbox"
                  checked={settings.enabled}
                  onChange={(event) =>
                    change({ enabled: event.target.checked })
                  }
                />
                Вход и регистрация по email
              </label>
              <div className="email-auth-fields">
                <label>
                  SMTP-сервер
                  <input
                    autoComplete="off"
                    maxLength={253}
                    value={settings.host}
                    placeholder="smtp.example.org"
                    required={settings.enabled}
                    onChange={(event) => change({ host: event.target.value })}
                  />
                </label>
                <label>
                  Порт
                  <input
                    type="number"
                    min={1}
                    max={65535}
                    value={settings.port}
                    required
                    onChange={(event) =>
                      change({ port: Number(event.target.value) })
                    }
                  />
                </label>
              </div>
              <p className="field-help">
                {settings.port === 465
                  ? "Защищённое соединение TLS."
                  : "Защищённое соединение STARTTLS (обычно порт 587)."}
              </p>
              <label>
                Логин SMTP
                <input
                  autoComplete="off"
                  maxLength={320}
                  value={settings.user}
                  required={settings.enabled}
                  onChange={(event) => change({ user: event.target.value })}
                />
              </label>
              <label>
                Пароль SMTP
                <input
                  type="password"
                  autoComplete="new-password"
                  maxLength={2048}
                  disabled={removePassword}
                  required={settings.enabled && !settings.hasPassword}
                  value={password}
                  placeholder={
                    settings.hasPassword
                      ? "Пароль сохранён"
                      : "Введите пароль SMTP"
                  }
                  onChange={(event) => {
                    setPassword(event.target.value);
                    change({});
                  }}
                />
              </label>
              {settings.hasPassword && (
                <p className="field-help">
                  Оставьте поле пустым, чтобы сохранить прежний пароль.
                </p>
              )}
              {settings.hasPassword && (
                <label className="check-row">
                  <input
                    type="checkbox"
                    checked={removePassword}
                    onChange={(event) => {
                      setRemovePassword(event.target.checked);
                      setPassword("");
                      change(event.target.checked ? { enabled: false } : {});
                    }}
                  />
                  Удалить сохранённый пароль
                </label>
              )}
              <label>
                Email отправителя
                <input
                  type="email"
                  autoComplete="off"
                  maxLength={254}
                  value={settings.from}
                  required={settings.enabled}
                  placeholder="mail@example.org"
                  onChange={(event) => change({ from: event.target.value })}
                />
              </label>
              {!settings.origin && (
                <p className="field-help">
                  Для включения входа нужно настроить PUBLIC_ORIGIN на сервере.
                </p>
              )}
              <div className="vk-auth-actions">
                <button
                  type="submit"
                  className="primary-action"
                  disabled={!dirty}
                >
                  {busy === "save" ? "Сохраняем…" : "Сохранить"}
                </button>
              </div>
            </fieldset>
          </form>
          <form
            className="email-auth-test"
            onSubmit={(event) => {
              event.preventDefault();
              void submit("test");
            }}
          >
            <fieldset
              disabled={
                !!busy || !settings.supported || dirty || !settings.hasPassword
              }
            >
              <label>
                Тестовое письмо
                <input
                  type="email"
                  required
                  maxLength={254}
                  value={recipient}
                  placeholder="Ваш email для проверки"
                  onChange={(event) => setRecipient(event.target.value)}
                />
              </label>
              <button type="submit" className="secondary-action">
                {busy === "test" ? "Отправляем…" : "Отправить тест"}
              </button>
            </fieldset>
            <p className="field-help">
              {dirty
                ? "Сначала сохраните изменения."
                : "Проверьте доставку тестового письма перед включением входа."}
            </p>
          </form>
        </>
      ) : (
        !error && <p role="status">Загружаем настройки…</p>
      )}
      <p className="email-auth-status" role="status">
        {message}
      </p>
      {error && (
        <p className="form-error" role="alert">
          {error}
        </p>
      )}
    </section>
  );
}
