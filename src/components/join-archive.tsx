import { useEffect, useState } from "react";
import { ArrowRight, Link2, ShieldCheck } from "lucide-react";
import { LoginButtons } from "./login-buttons.tsx";
import "../styles/join-archive.css";

type Preview = {
  archiveId: string;
  title: string;
  role: "reader" | "relative";
};

export function JoinArchive({
  archiveId,
  token,
}: {
  archiveId: string;
  token: string;
}) {
  const [preview, setPreview] = useState<Preview | null>(null);
  const [account, setAccount] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const body = JSON.stringify({ archiveId, token });
  useEffect(() => {
    const controller = new AbortController();
    void Promise.all([
      fetch("/api/account/invitations/preview", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body,
        signal: controller.signal,
      }).then(async (response) => {
        const result = await response.json();
        if (!response.ok)
          throw new Error(result.error || "Приглашение недоступно.");
        return result as Preview;
      }),
      fetch("/api/session", {
        cache: "no-store",
        signal: controller.signal,
      }).then((response) => response.json()),
    ])
      .then(([result, session]) => {
        if (controller.signal.aborted) return;
        setPreview(result);
        setAccount(session.account?.name || session.user?.name || null);
      })
      .catch((reason) => {
        if (!controller.signal.aborted) setError((reason as Error).message);
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [body]);

  const accept = async () => {
    if (busy) return;
    setBusy(true);
    setError("");
    try {
      const response = await fetch("/api/account/invitations/accept", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body,
      });
      const result = await response.json();
      if (!response.ok)
        throw new Error(result.error || "Не удалось принять приглашение.");
      sessionStorage.removeItem("drevo_pending_invite");
      window.location.assign(result.path);
    } catch (reason) {
      setError((reason as Error).message);
      setBusy(false);
    }
  };

  return (
    <main className="join-archive-page">
      <section
        className="join-archive-card"
        aria-labelledby="join-archive-title"
      >
        <span className="join-archive-icon">
          <Link2 size={24} aria-hidden="true" />
        </span>
        {loading ? (
          <p role="status">Проверяем приглашение…</p>
        ) : preview ? (
          <>
            <span className="join-archive-eyebrow">
              Приглашение в семейный архив
            </span>
            <h1 id="join-archive-title">{preview.title}</h1>
            <p>
              Вы сможете{" "}
              {preview.role === "reader"
                ? "смотреть дерево"
                : "добавлять свои сведения"}{" "}
              вместе с родственниками.
            </p>
            <div className="join-archive-privacy">
              <ShieldCheck size={18} aria-hidden="true" /> Доступ действует
              только для этого дерева.
            </div>
            {account ? (
              <>
                <p className="join-archive-account">Вы вошли как {account}</p>
                <button
                  type="button"
                  className="primary-action"
                  disabled={busy}
                  onClick={() => void accept()}
                >
                  {busy ? "Присоединяем…" : "Присоединиться"}{" "}
                  <ArrowRight size={18} aria-hidden="true" />
                </button>
              </>
            ) : (
              <>
                <p>Войдите, чтобы принять приглашение.</p>
                <LoginButtons
                  onBeforeNavigate={() => {
                    sessionStorage.setItem(
                      "drevo_pending_invite",
                      window.location.pathname,
                    );
                  }}
                />
              </>
            )}
          </>
        ) : (
          <>
            <h1 id="join-archive-title">Приглашение недоступно</h1>
            <p>Попросите владельца дерева отправить новую ссылку.</p>
          </>
        )}
        {error && (
          <p className="join-archive-error" role="alert">
            {error}
          </p>
        )}
        <a className="join-archive-home" href="/account">
          Открыть личный кабинет
        </a>
      </section>
    </main>
  );
}
