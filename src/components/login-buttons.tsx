import { archiveFetch } from "../data/archive-fetch.ts";
import { useEffect, useState } from "react";
import { markEntrySequence } from "./entry-sequence";
import "../styles/login-buttons.css";

type Providers = { vk: boolean; yandex: boolean };
export function LoginButtons() {
  const [providers, setProviders] = useState<Providers | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    const controller = new AbortController();
    archiveFetch("/api/session", { cache: "no-store", signal: controller.signal })
      .then(async (response) => {
        if (!response.ok) throw new Error("Session unavailable");
        const data = await response.json();
        if (!controller.signal.aborted)
          setProviders({ vk: data.vk === true, yandex: data.yandex === true });
      })
      .catch(() => {
        if (!controller.signal.aborted) setFailed(true);
      });
    return () => controller.abort();
  }, []);
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
      </div>
      {failed ? (
        <p role="alert">
          Не удалось загрузить способы входа. Обновите страницу.
        </p>
      ) : providers && !providers.vk && !providers.yandex ? (
        <p>Вход пока недоступен.</p>
      ) : !providers ? (
        <span role="status">Загружаем способы входа…</span>
      ) : null}
    </div>
  );
}
