import { useCallback, useEffect, useRef, useState } from "react";
import { archiveFetch } from "../data/archive-fetch.ts";
import {
  createNotificationSound,
  readNotificationSoundPreference,
  writeNotificationSoundPreference,
} from "../data/notification-sound.ts";
import { archiveResourceUrl } from "../domain/archive-context.ts";
import {
  combineNotificationPages,
  notificationArrival,
} from "../domain/notification-arrivals.ts";
import type { ArchiveNotificationsPage } from "../shared/archive-notifications.ts";

type Runtime = {
  scope: string;
  active: boolean;
  stopped: boolean;
  jobs: number;
  tail: Promise<void>;
  controllers: Map<AbortController, boolean>;
  page: ArchiveNotificationsPage | null;
  error: string;
  highWater: number | null;
  soundEnabled: boolean;
  sound: ReturnType<typeof createNotificationSound>;
};
type Snapshot = {
  scope: string;
  page: ArchiveNotificationsPage | null;
  error: string;
  busy: boolean;
  soundEnabled: boolean;
};

export function useArchiveNotifications({
  userId,
  open,
}: {
  userId: string;
  open: boolean;
}) {
  // Capture the resource before async work; a later archive switch cannot retarget a POST.
  const scopedResource = archiveResourceUrl("/api/notifications");
  const resource =
    typeof window === "undefined"
      ? scopedResource
      : new URL(scopedResource, window.location.origin).href;
  const scope = `${resource}\n${userId}`;
  const runtime = useRef<Runtime | null>(null);
  const openState = useRef(open);
  useEffect(() => {
    openState.current = open;
  }, [open]);
  const [snapshot, setSnapshot] = useState<Snapshot>({
    scope,
    page: null,
    error: "",
    busy: false,
    soundEnabled: true,
  });
  const publish = useCallback((state: Runtime) => {
    if (!state.active || runtime.current !== state) return;
    setSnapshot({
      scope: state.scope,
      page: state.page,
      error: state.error,
      busy: state.jobs > 0 && !state.stopped,
      soundEnabled: state.soundEnabled,
    });
  }, []);
  const enqueue = useCallback(
    async (work: (state: Runtime) => Promise<void>, polling = false) => {
      const state = runtime.current;
      if (
        !state ||
        !state.active ||
        state.stopped ||
        state.scope !== scope ||
        (polling && state.jobs)
      )
        return;
      state.jobs++;
      publish(state);
      const next = state.tail.then(async () => {
        try {
          if (!state.active || state.stopped) return;
          await work(state);
          if (!state.stopped) state.error = "";
        } catch (cause) {
          if (state.active)
            state.error =
              cause instanceof Error
                ? cause.message
                : "Не удалось загрузить уведомления";
        } finally {
          state.jobs--;
          publish(state);
        }
      });
      state.tail = next.catch(() => {});
      await next;
    },
    [scope, publish],
  );
  const request = useCallback(
    async (
      state: Runtime,
      before?: number,
      body?: { id: number } | { through: number },
      deadline = Date.now() + 10_000,
      receipt = false,
    ) => {
      if (!state.active || deadline <= Date.now())
        throw new Error("Уведомления не ответили вовремя. Повторите запрос.");
      const controller = new AbortController();
      state.controllers.set(controller, receipt);
      const timeout = setTimeout(
        () => controller.abort(),
        deadline - Date.now(),
      );
      try {
        const response = await archiveFetch(
          `${resource}${before ? `?before=${before}` : ""}`,
          {
            cache: "no-store",
            signal: controller.signal,
            ...(receipt ? { keepalive: true } : {}),
            ...(body
              ? {
                  method: "POST",
                  headers: { "Content-Type": "application/json" },
                  body: JSON.stringify(body),
                }
              : {}),
          },
        );
        if (response.status === 401 || response.status === 403) {
          state.stopped = true;
          state.page = null;
          state.highWater = null;
          state.error = "Доступ к уведомлениям завершён. Войдите снова.";
          for (const [pending, receipt] of state.controllers)
            if (pending !== controller && !receipt) pending.abort();
          publish(state);
          throw new Error("Доступ к уведомлениям завершён. Войдите снова.");
        }
        if (!response.ok)
          throw new Error(
            body
              ? "Не удалось отметить уведомления"
              : "Не удалось загрузить уведомления",
          );
        const page = (await response.json()) as ArchiveNotificationsPage;
        if (state.stopped)
          throw new Error("Доступ к уведомлениям завершён. Войдите снова.");
        if (controller.signal.aborted)
          throw new Error("Уведомления не ответили вовремя. Повторите запрос.");
        return page;
      } catch (cause) {
        if (state.stopped)
          throw new Error("Доступ к уведомлениям завершён. Войдите снова.");
        if (controller.signal.aborted && state.active)
          throw new Error("Уведомления не ответили вовремя. Повторите запрос.");
        throw cause;
      } finally {
        clearTimeout(timeout);
        state.controllers.delete(controller);
      }
    },
    [resource, publish],
  );
  const refresh = useCallback(
    async (
      state: Runtime,
      audible: boolean,
      head?: ArchiveNotificationsPage,
    ) => {
      const deadline = Date.now() + 10_000;
      const floor = openState.current ? (state.page?.items.at(-1)?.id ?? 0) : 0;
      const pages = [
        head ?? (await request(state, undefined, undefined, deadline)),
      ];
      const visited = new Set<number>();
      // Revalidate the loaded range instead of keeping old tail records after a
      // permission/deletion change. Stable event ids keep the list DOM and scroll.
      while (
        floor &&
        pages.at(-1)!.next &&
        (pages.at(-1)!.items.at(-1)?.id ?? 0) > floor
      ) {
        const cursor = pages.at(-1)!.next!;
        if (visited.has(cursor))
          throw new Error(
            "Не удалось обновить список уведомлений. Повторите запрос.",
          );
        visited.add(cursor);
        pages.push(await request(state, cursor, undefined, deadline));
      }
      if (!state.active || state.stopped || runtime.current !== state) return;
      const page = combineNotificationPages(pages, floor);
      const arrival = notificationArrival(state.highWater, page);
      state.highWater = arrival.highWater;
      state.page = page;
      if (
        state.active &&
        document.visibilityState === "visible" &&
        audible &&
        arrival.sound &&
        state.soundEnabled
      )
        state.sound.play();
    },
    [request],
  );
  const load = useCallback(
    async (before?: number) => {
      await enqueue(async (state) => {
        if (!before) return await refresh(state, false);
        const next = await request(state, before);
        if (!state.active || state.stopped || runtime.current !== state) return;
        state.page = combineNotificationPages([
          ...(state.page ? [state.page] : []),
          next,
        ]);
        state.highWater = notificationArrival(
          state.highWater,
          state.page,
        ).highWater;
      });
    },
    [enqueue, refresh, request],
  );
  const readAll = useCallback(async () => {
    // Capture only the unread watermark already delivered to this user. A new
    // event arriving while the queued POST waits must not be swallowed.
    const through =
      runtime.current?.scope === scope ? runtime.current.page?.latest : 0;
    if (!through) return;
    await enqueue(async (state) => {
      await refresh(state, false, await request(state, undefined, { through }));
    });
  }, [scope, enqueue, refresh, request]);
  const markRead = useCallback(
    async (id: number) => {
      const state = runtime.current;
      if (!state || !state.active || state.stopped || state.scope !== scope)
        return;
      // Begin the small receipt immediately: a real href may navigate before a
      // pending poll completes. Keepalive preserves it across that navigation.
      const receipt = request(
        state,
        undefined,
        { id },
        Date.now() + 10_000,
        true,
      );
      void receipt.catch(() => {});
      await enqueue(async (current) => {
        await receipt;
        await refresh(current, false);
      });
    },
    [scope, enqueue, refresh, request],
  );
  const toggleSound = useCallback(() => {
    const state = runtime.current;
    if (!state || state.scope !== scope || !state.active) return;
    state.soundEnabled = !state.soundEnabled;
    writeNotificationSoundPreference(userId, state.soundEnabled);
    publish(state);
  }, [scope, userId, publish]);
  useEffect(() => {
    const state: Runtime = {
      scope,
      active: true,
      stopped: !userId,
      jobs: 0,
      tail: Promise.resolve(),
      controllers: new Map(),
      page: null,
      error: "",
      highWater: null,
      soundEnabled: readNotificationSoundPreference(userId),
      sound: createNotificationSound(),
    };
    runtime.current = state;
    const poll = () => {
      if (document.visibilityState === "visible")
        void enqueue((current) => refresh(current, true), true);
    };
    queueMicrotask(() => {
      if (state.active) {
        publish(state);
        poll();
      }
    });
    const interval = setInterval(poll, 30_000);
    document.addEventListener("visibilitychange", poll);
    window.addEventListener("focus", poll);
    return () => {
      state.active = false;
      clearInterval(interval);
      document.removeEventListener("visibilitychange", poll);
      window.removeEventListener("focus", poll);
      for (const [controller, receipt] of state.controllers)
        if (!receipt) controller.abort();
      state.sound.dispose();
      if (runtime.current === state) runtime.current = null;
    };
  }, [scope, userId, enqueue, refresh, publish]);
  useEffect(() => {
    if (open) void load();
  }, [open, load]);
  return {
    page: snapshot.scope === scope ? snapshot.page : null,
    error: snapshot.scope === scope ? snapshot.error : "",
    busy: snapshot.scope === scope ? snapshot.busy : false,
    soundEnabled: snapshot.scope === scope ? snapshot.soundEnabled : true,
    load,
    readAll,
    markRead,
    toggleSound,
  };
}
