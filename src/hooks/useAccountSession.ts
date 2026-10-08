import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { archiveFetch } from "../data/archive-fetch.ts";
import { archiveContextAt } from "../domain/archive-context.ts";
import { isScopedUser } from "../domain/tree-access.ts";
import type { ArchiveUser, GlobalRole } from "../domain/access.ts";
import type { AccountSession } from "../shared/account-session.ts";
import type { ArchiveView } from "../components/archive-navigation";
import type { useArchive } from "./useArchive";

function sameCachedReadProjection(previous: ArchiveUser, current: ArchiveUser) {
  if (
    previous.id !== current.id ||
    current.approved !== true ||
    isScopedUser(previous) !== isScopedUser(current)
  )
    return false;
  // Local/global role and tier changes affect actions, but not the family
  // projection. Scoped graph visibility additionally depends on this anchor.
  return !isScopedUser(previous) || previous.personId === current.personId;
}

/** Owns session requests, their versions and the restored-page privacy gate. */
export function useAccountSession({
  archive,
  view,
  requestedView,
  previewActive,
}: {
  archive: Pick<
    ReturnType<typeof useArchive>,
    | "syncSessionUser"
    | "closeChangedPrivateView"
    | "hasPendingRead"
    | "user"
    | "family"
    | "needsLogin"
  >;
  view: ArchiveView;
  requestedView: ArchiveView;
  previewActive: boolean;
}) {
  const [accountSession, setAccountSession] = useState<AccountSession | null>(
    null,
  );
  const [accountLoading, setAccountLoading] = useState(true);
  const [accountError, setAccountError] = useState(false);
  const user = archive.user;
  const accountSessionVersion = useRef(0);
  const restoredSessionController = useRef<AbortController | null>(null);
  const restoredSessionDialog = useRef<HTMLDialogElement>(null);
  const [restoredSessionState, setRestoredSessionState] = useState<
    "ready" | "checking" | "retry"
  >("ready");
  const restoredSessionStateRef = useRef<"ready" | "checking" | "retry">(
    "ready",
  );
  const archiveSessionActions = useRef({
    sync: archive.syncSessionUser,
    closeChanged: archive.closeChangedPrivateView,
    hasPendingRead: archive.hasPendingRead,
    user: archive.user,
    hasFamily: Boolean(archive.family),
    view: requestedView,
  });
  useLayoutEffect(() => {
    archiveSessionActions.current = {
      sync: archive.syncSessionUser,
      closeChanged: archive.closeChangedPrivateView,
      hasPendingRead: archive.hasPendingRead,
      user: archive.user,
      hasFamily: Boolean(archive.family),
      view: requestedView,
    };
  }, [
    archive.syncSessionUser,
    archive.closeChangedPrivateView,
    archive.hasPendingRead,
    archive.user,
    archive.family,
    requestedView,
  ]);
  const finishRestoredSession = useCallback((session: AccountSession) => {
    const previous = archiveSessionActions.current;
    if (previous.user) {
      if (
        !session.user?.approved ||
        (!session.local && !session.account && !session.preview)
      )
        previous.closeChanged(true);
      else if (!sameCachedReadProjection(previous.user, session.user))
        previous.closeChanged(false);
      else previous.sync(session.user);
    } else if (
      (previous.hasFamily || previous.hasPendingRead()) &&
      (archiveContextAt(window.location.pathname) ||
        (previous.view !== "account" && previous.view !== "admin"))
    ) {
      // No actor was materialized for the pending snapshot. Its original
      // authorization cannot be compared, so require an explicit reopen.
      previous.closeChanged(session.user?.approved !== true);
    } else previous.sync(session.user);
    setAccountSession(session);
    setAccountError(false);
    setAccountLoading(false);
    restoredSessionStateRef.current = "ready";
    setRestoredSessionState("ready");
  }, []);
  const validateRestoredSession = useCallback(() => {
    restoredSessionController.current?.abort();
    const controller = new AbortController();
    restoredSessionController.current = controller;
    const version = ++accountSessionVersion.current;
    restoredSessionStateRef.current = "checking";
    setRestoredSessionState("checking");
    void archiveFetch("/api/session", {
      cache: "no-store",
      signal: controller.signal,
    })
      .then(async (response) => {
        if (!response.ok) throw new Error("Не удалось проверить сеанс");
        return response.json() as Promise<AccountSession>;
      })
      .then((session) => {
        if (
          controller.signal.aborted ||
          version !== accountSessionVersion.current
        )
          return;
        finishRestoredSession(session);
      })
      .catch(() => {
        if (
          controller.signal.aborted ||
          version !== accountSessionVersion.current
        )
          return;
        // Busy or failed reads cannot prove revocation. Keep the mounted graph
        // and editor state hidden until a retry validates the current session.
        restoredSessionStateRef.current = "retry";
        setRestoredSessionState("retry");
      });
  }, [finishRestoredSession]);
  useEffect(() => {
    const onPageShow = (event: PageTransitionEvent) => {
      if (event.persisted) validateRestoredSession();
    };
    window.addEventListener("pageshow", onPageShow);
    return () => {
      window.removeEventListener("pageshow", onPageShow);
      restoredSessionController.current?.abort();
    };
  }, [validateRestoredSession]);
  useLayoutEffect(() => {
    const dialog = restoredSessionDialog.current;
    if (!dialog || restoredSessionState === "ready") return;
    // A native dialog sits above an already-open photo/PDF modal in the top layer.
    if (!dialog.open) dialog.showModal();
    return () => {
      if (dialog.open) dialog.close();
    };
  }, [restoredSessionState]);
  useEffect(() => {
    if (
      view !== "account" &&
      view !== "admin" &&
      !archive.needsLogin &&
      !previewActive
    )
      return;
    const controller = new AbortController();
    const version = ++accountSessionVersion.current;
    archiveFetch("/api/session", {
      cache: "no-store",
      signal: controller.signal,
    })
      .then((response) => {
        if (!response.ok) throw new Error("Не удалось загрузить профиль");
        return response.json();
      })
      .then((session: AccountSession) => {
        if (
          controller.signal.aborted ||
          version !== accountSessionVersion.current
        )
          return;
        if (restoredSessionStateRef.current !== "ready") {
          finishRestoredSession(session);
          return;
        }
        setAccountSession(session);
        setAccountError(false);
        setAccountLoading(false);
      })
      .catch(() => {
        if (
          !controller.signal.aborted &&
          version === accountSessionVersion.current
        ) {
          if (restoredSessionStateRef.current !== "ready") {
            restoredSessionStateRef.current = "retry";
            setRestoredSessionState("retry");
            return;
          }
          setAccountSession(null);
          setAccountError(true);
          setAccountLoading(false);
        }
      });
    return () => controller.abort();
  }, [view, archive.needsLogin, finishRestoredSession, previewActive]);

  const updateOwnRole = (role: GlobalRole) => {
    setAccountSession((current) =>
      current?.account
        ? {
            ...current,
            account: { ...current.account, globalRole: role },
            user: current.user
              ? {
                  ...current.user,
                  globalRole: role,
                  platformAdmin: role === "admin",
                }
              : null,
          }
        : current,
    );
  };
  const updateOwnTier = (fullAccess: boolean) => {
    const version = ++accountSessionVersion.current;
    setAccountSession((current) =>
      current
        ? {
            ...current,
            account: current.account
              ? { ...current.account, fullAccess }
              : null,
            user: current.user
              ? { ...current.user, fullAccess, aiAvailable: false }
              : null,
          }
        : null,
    );
    if (
      user &&
      user.id === (accountSession?.account || accountSession?.user)?.id
    )
      archive.syncSessionUser({ ...user, fullAccess, aiAvailable: false });
    void archiveFetch("/api/session", { cache: "no-store" })
      .then(async (response) => {
        if (!response.ok) throw new Error("Не удалось обновить данные сеанса");
        return response.json() as Promise<AccountSession>;
      })
      .then((session) => {
        if (version !== accountSessionVersion.current) return;
        setAccountSession(session);
        setAccountError(false);
        if (
          user &&
          user.id === (accountSession?.account || accountSession?.user)?.id
        )
          archive.syncSessionUser(session.user);
      })
      .catch(() => {
        if (version === accountSessionVersion.current) setAccountError(true);
      });
  };
  return {
    accountSession,
    accountLoading,
    accountError,
    restoredSessionState,
    restoredSessionDialog,
    validateRestoredSession,
    updateOwnRole,
    updateOwnTier,
  };
}
