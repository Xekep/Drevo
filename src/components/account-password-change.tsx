import { useState, type FormEvent } from "react";

/** Change the email credential without ending the session that submitted it. */
export function AccountPasswordChange({
  onChanged,
}: {
  onChanged: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirmation, setConfirmation] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");

  function close() {
    setOpen(false);
    setCurrentPassword("");
    setNewPassword("");
    setConfirmation("");
    setError("");
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy) return;
    setError("");
    setMessage("");
    if (newPassword !== confirmation) {
      setError("Новые пароли не совпадают.");
      return;
    }
    setBusy(true);
    try {
      const response = await fetch("/api/auth/email/password/change", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ currentPassword, newPassword }),
      });
      const result = await response.json();
      if (!response.ok)
        throw new Error(result.error || "Не удалось изменить пароль.");
      close();
      setMessage("Пароль изменён. Другие сеансы завершены.");
      onChanged();
    } catch (cause) {
      setError(
        cause instanceof Error ? cause.message : "Не удалось изменить пароль.",
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="account-email-link account-password-change">
      {!open ? (
        <button
          type="button"
          className="account-row-action"
          onClick={() => {
            setMessage("");
            setOpen(true);
          }}
        >
          Сменить пароль
        </button>
      ) : (
        <form onSubmit={(event) => void submit(event)}>
          <label>
            Текущий пароль
            <input
              type="password"
              name="current-password"
              autoComplete="current-password"
              value={currentPassword}
              onChange={(event) => setCurrentPassword(event.target.value)}
              required
            />
          </label>
          <label>
            Новый пароль
            <input
              type="password"
              name="new-password"
              autoComplete="new-password"
              value={newPassword}
              onChange={(event) => setNewPassword(event.target.value)}
              required
              minLength={12}
            />
          </label>
          <label>
            Повторите новый пароль
            <input
              type="password"
              name="confirm-password"
              autoComplete="new-password"
              value={confirmation}
              onChange={(event) => setConfirmation(event.target.value)}
              required
              minLength={12}
            />
          </label>
          {error && <p role="alert">{error}</p>}
          <div className="account-email-actions">
            <button type="submit" disabled={busy}>
              {busy ? "Сохраняем…" : "Сохранить пароль"}
            </button>
            <button type="button" disabled={busy} onClick={close}>
              Отмена
            </button>
          </div>
        </form>
      )}
      {message && <p role="status">{message}</p>}
    </div>
  );
}
