import { useEffect, useState } from "react";
import type { VkAuthStatus } from "../shared/vk-auth-settings";
import "../styles/vk-auth-admin.css";

export function VkAuthAdmin() {
  const [settings, setSettings] = useState<VkAuthStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [saved, setSaved] = useState(false);
  useEffect(() => {
    const controller = new AbortController();
    fetch("/api/admin/auth/vk", {
      signal: controller.signal,
      cache: "no-store",
    })
      .then(async (response) => {
        const data = await response.json();
        if (!response.ok)
          throw new Error(data.error || "Не удалось загрузить настройки VK");
        if (!controller.signal.aborted) setSettings(data);
      })
      .catch((reason) => {
        if (!controller.signal.aborted) setError(reason.message);
      });
    return () => controller.abort();
  }, []);
  async function save(event: React.FormEvent) {
    event.preventDefault();
    if (!settings || busy) return;
    setBusy(true);
    setError("");
    setSaved(false);
    try {
      const response = await fetch("/api/admin/auth/vk", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          enabled: settings.enabled,
          clientId: settings.clientId,
        }),
      });
      const data = await response.json();
      if (!response.ok)
        throw new Error(data.error || "Не удалось сохранить настройки VK");
      setSettings(data);
      setSaved(true);
    } catch (reason) {
      setError(
        reason instanceof Error
          ? reason.message
          : "Не удалось сохранить настройки VK",
      );
    } finally {
      setBusy(false);
    }
  }
  return (
    <section
      className="admin-card vk-auth-settings"
      aria-label="Настройки входа через VK"
    >
      {settings ? (
        <form onSubmit={save}>
          <fieldset disabled={busy}>
            <label className="check-row">
              <input
                type="checkbox"
                checked={settings.enabled}
                onChange={(event) => {
                  setSettings({ ...settings, enabled: event.target.checked });
                  setSaved(false);
                }}
              />
              Вход через VK ID
            </label>
            <label>
              ID приложения
              <input
                inputMode="numeric"
                autoComplete="off"
                maxLength={20}
                value={settings.clientId}
                placeholder="Например, 12345678"
                onChange={(event) => {
                  setSettings({ ...settings, clientId: event.target.value });
                  setSaved(false);
                }}
              />
            </label>
            <p className="field-help">
              Создайте веб-приложение в VK ID и укажите адрес возврата:
            </p>
            {settings.callbackUrl ? (
              <code className="vk-auth-callback">{settings.callbackUrl}</code>
            ) : (
              <p className="field-help">
                Адрес возврата появится после настройки домена сервера.
              </p>
            )}
            <div className="vk-auth-actions">
              <button type="submit" className="primary">
                {busy ? "Сохраняем…" : "Сохранить"}
              </button>
              <span role="status">{saved ? "Сохранено" : ""}</span>
            </div>
          </fieldset>
        </form>
      ) : (
        !error && <p role="status">Загружаем настройки…</p>
      )}
      {error && (
        <p className="form-error" role="alert">
          {error}
        </p>
      )}
    </section>
  );
}
