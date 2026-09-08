import { useEffect, useState } from "react";
import { EditorDialog } from "./editor-dialog";
export function LoginDialog({
  onClose,
  onLogin,
}: {
  onClose: () => void;
  onLogin: () => void;
}) {
  const [username, setUsername] = useState("xekep"),
    [password, setPassword] = useState(""),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false);
  const [yandex, setYandex] = useState(false);
  useEffect(() => {
    const controller = new AbortController();
    void fetch("/api/session", { signal: controller.signal })
      .then((r) => r.json())
      .then((s) => setYandex(s.yandex === true))
      .catch(() => {});
    return () => controller.abort();
  }, []);
  return (
    <EditorDialog title="Вход в семейный архив" onClose={onClose}>
      <form
        className="archive-form"
        onSubmit={async (e) => {
          e.preventDefault();
          setBusy(true);
          setError("");
          try {
            const response = await fetch("/api/login", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ username, password }),
            });
            if (!response.ok)
              throw new Error(
                "Не удалось войти. Проверьте логин и пароль. После нескольких неудачных попыток подождите 15 минут.",
              );
            onLogin();
            onClose();
          } catch (e) {
            setError((e as Error).message);
          } finally {
            setBusy(false);
          }
        }}
      >
        <p>
          После входа можно изменять древо, добавлять фотографии и скачивать
          резервную копию базы.
        </p>
        {yandex && (
          <a className="yandex-login" href="/auth/yandex">
            <b>Я</b> Войти с Яндекс ID
          </a>
        )}
        <label>
          Логин
          <input
            autoComplete="username"
            required
            value={username}
            onChange={(e) => setUsername(e.target.value)}
          />
        </label>
        <label>
          Пароль
          <input
            type="password"
            autoComplete="current-password"
            required
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />
        </label>
        {error && (
          <p role="alert" className="form-error">
            {error}
          </p>
        )}
        <button className="primary-action" disabled={busy}>
          {busy ? "Входим…" : "Войти"}
        </button>
      </form>
    </EditorDialog>
  );
}
