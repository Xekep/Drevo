import { lazy, useCallback, useEffect, useRef, useState } from "react";
import type { AccountSession } from "../shared/account-session.ts";
import { fetchWithTimeout } from "../data/request-timeout.ts";
import { LoginButtons } from "./login-buttons";

export type DiscoveryReadAccess = { checking: boolean; revision: number; requireLogin: (revision: number) => void };
const PublicPeople = lazy(() => import("./public-people"));

/** Session checks belong to this route, independently of archive membership. */
export function DiscoveryAccess() {
  const [state, setState] = useState<"pending" | "ready" | "checking" | "guest" | "error">("pending");
  const [revision, setRevision] = useState(0);
  const request = useRef<AbortController | null>(null);
  const version = useRef(0);
  const requireLogin = useCallback((requestRevision: number) => {
    if (requestRevision !== version.current) return;
    version.current += 1;
    request.current?.abort();
    setState("guest");
  }, []);
  const check = useCallback(() => {
    request.current?.abort();
    const controller = new AbortController();
    request.current = controller;
    const current = ++version.current;
    return fetchWithTimeout("/api/session", { cache: "no-store", signal: controller.signal }).then(async (response) => {
      if (controller.signal.aborted || current !== version.current) return;
      if (response.status === 401) { setState("guest"); return; }
      if (!response.ok) throw new Error("Session unavailable");
      const session = await response.json() as AccountSession;
      if (controller.signal.aborted || current !== version.current) return;
      if (session.account?.id || session.user?.id) {
        setRevision(current);
        setState("ready");
      } else setState("guest");
    }).catch(() => {
      if (!controller.signal.aborted && current === version.current) setState("error");
    });
  }, []);
  useEffect(() => {
    const recheck = () => {
      if (document.visibilityState !== "visible") return;
      setState((previous) => previous === "ready" || previous === "checking" ? "checking" : "pending");
      void check();
    };
    void check();
    window.addEventListener("focus", recheck);
    window.addEventListener("pageshow", recheck);
    document.addEventListener("visibilitychange", recheck);
    return () => {
      version.current += 1;
      request.current?.abort();
      window.removeEventListener("focus", recheck);
      window.removeEventListener("pageshow", recheck);
      document.removeEventListener("visibilitychange", recheck);
    };
  }, [check]);
  const checking = state === "checking";
  return <>
    {state !== "ready" && <main className="public-people-page">
      <a href="/">← Древо</a>
      <h1>Поиск опубликованных людей</h1>
      {(state === "pending" || checking) && <p role="status">Проверяем вход…</p>}
      {state === "guest" && <>
        <p>Войдите, чтобы искать опубликованных людей и открывать их карточки.</p>
        <LoginButtons />
      </>}
      {state === "error" && <>
        <p role="alert">Не удалось проверить вход. Проверьте соединение и повторите попытку.</p>
        <button type="button" onClick={() => { setState("pending"); void check(); }}>Повторить проверку</button>
      </>}
    </main>}
    {(state === "ready" || checking) && <div hidden={checking} inert={checking}>
      <PublicPeople checking={checking} revision={revision} requireLogin={requireLogin} />
    </div>}
  </>;
}
