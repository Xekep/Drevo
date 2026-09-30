import { useEffect, useState, type FormEvent } from "react";

/** Linking changes login methods for this account, never archive membership. */
export function AccountEmailLink({ linked }: { linked: boolean }) {
  const [available, setAvailable] = useState(false);
  const [open, setOpen] = useState(false);
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  useEffect(() => {
    if (linked) return;
    const controller = new AbortController();
    fetch("/api/session", { cache: "no-store", signal: controller.signal })
      .then((response) => response.json())
      .then((data) => {
        if (!controller.signal.aborted) setAvailable(data.email === true);
      })
      .catch(() => {});
    return () => controller.abort();
  }, [linked]);
  if (linked || !available) return null;

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy) return;
    setBusy(true);
    setError("");
    setMessage("");
    try {
      const response = await fetch("/api/auth/email/link/request", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email, password }),
      });
      const result = await response.json();
      if (!response.ok)
        throw new Error(result.error || "Не удалось отправить письмо.");
      setMessage(result.message || "Проверьте почту.");
      setPassword("");
    } catch (cause) {
      setError(
        cause instanceof Error ? cause.message : "Не удалось отправить письмо.",
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="account-email-link">
      {!open ? (
        <button
          type="button"
          className="account-row-action"
          onClick={() => setOpen(true)}
        >
          Подключить вход по почте
        </button>
      ) : (
        <form onSubmit={(event) => void submit(event)}>
          <p>
            Добавьте почту к этому аккаунту. После подтверждения можно будет
            входить и через неё.
          </p>
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
          <label>
            Новый пароль
            <input
              type="password"
              autoComplete="new-password"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              required
              minLength={12}
            />
          </label>
          {message && <p role="status">{message}</p>}
          {error && <p role="alert">{error}</p>}
          <div className="account-email-actions">
            <button type="submit" disabled={busy}>
              {busy ? "Отправляем…" : "Отправить ссылку"}
            </button>
            <button type="button" onClick={() => setOpen(false)}>
              Отмена
            </button>
          </div>
        </form>
      )}
    </div>
  );
}
