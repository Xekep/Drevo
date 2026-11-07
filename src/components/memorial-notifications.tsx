import { useEffect, useState, type MouseEvent } from "react";
import { Cake, CalendarDays } from "lucide-react";
import { archiveFetch } from "../data/archive-fetch.ts";
import { browserTimeZone } from "../data/browser-time-zone.ts";
import {
  archiveResourceUrl,
  scopedArchivePath,
} from "../domain/archive-context.ts";
import {
  memorialDateLabel,
  type MemorialDate,
} from "../domain/memorial-dates.ts";

/** A dated section, not fabricated audit activity or a new unread event every day. */
export function MemorialNotifications({
  beforeLeave,
  onFollow,
  onPerson,
}: {
  beforeLeave?: () => boolean;
  onFollow: () => void;
  onPerson?: (id: string) => void;
}) {
  const resource = archiveResourceUrl("/api/notifications");
  const [snapshot, setSnapshot] = useState<{
    resource: string;
    items: MemorialDate[];
    error: boolean;
  } | null>(null);
  useEffect(() => {
    const controller = new AbortController();
    let pending = false;
    let stopped = false;
    const refresh = async () => {
      if (pending || stopped || controller.signal.aborted) return;
      pending = true;
      try {
        const response = await archiveFetch(
          `${resource}?memorial=1&birthdays=1&timeZone=${encodeURIComponent(browserTimeZone() || "UTC")}`,
          {
            cache: "no-store",
            signal: AbortSignal.any([
              controller.signal,
              AbortSignal.timeout(10_000),
            ]),
          },
        );
        if (response.status === 401 || response.status === 403) stopped = true;
        if (!response.ok) throw new Error("Не удалось загрузить памятные даты");
        const result = (await response.json()) as { items: MemorialDate[] };
        if (!controller.signal.aborted)
          setSnapshot({ resource, items: result.items, error: false });
      } catch {
        if (!controller.signal.aborted)
          setSnapshot({ resource, items: [], error: true });
      } finally {
        pending = false;
      }
    };
    void refresh();
    // Reopen always revalidates; midnight in a long-open list also changes dates.
    const interval = setInterval(() => {
      if (document.visibilityState === "visible") void refresh();
    }, 60_000);
    const resume = () => {
      if (document.visibilityState === "visible") void refresh();
    };
    document.addEventListener("visibilitychange", resume);
    window.addEventListener("focus", resume);
    return () => {
      controller.abort();
      clearInterval(interval);
      document.removeEventListener("visibilitychange", resume);
      window.removeEventListener("focus", resume);
    };
  }, [resource]);
  const current = snapshot?.resource === resource ? snapshot : null;
  const follow = (event: MouseEvent<HTMLAnchorElement>, personId: string) => {
    if (
      event.defaultPrevented ||
      event.button !== 0 ||
      event.ctrlKey ||
      event.metaKey ||
      event.shiftKey ||
      event.altKey
    )
      return;
    if (beforeLeave && !beforeLeave()) {
      event.preventDefault();
      return;
    }
    if (onPerson) { event.preventDefault(); onPerson(personId); }
    onFollow();
  };
  if (!current) return <p role="status">Загрузка памятных дат…</p>;
  if (current.error)
    return (
      <p role="status">
        Не удалось загрузить памятные даты. Откройте уведомления повторно.
      </p>
    );
  if (!current.items.length) return null;
  return (
    <section aria-label="Ближайшие памятные даты">
      <h3 className="notifications-section-title">Ближайшие памятные даты</h3>
      {current.items.map((item) => (
        <a
          key={item.id}
          className="notification-item"
          href={scopedArchivePath(
            `/people/${encodeURIComponent(item.personId)}`,
          )}
          onClick={event => follow(event, item.personId)}
        >
          {item.kind === "birthday" ? (
            <Cake size={18} aria-hidden="true" />
          ) : (
            <CalendarDays size={18} aria-hidden="true" />
          )}
          <span className="notification-content">
            <strong>{item.personName}</strong>
            <span>{memorialDateLabel(item)}</span>
            <time dateTime={item.date}>
              {item.days === 0
                ? item.kind === "birthday"
                  ? "Сегодня день рождения"
                  : "Сегодня день памяти"
                : `Через ${item.days} дн.`}
            </time>
          </span>
        </a>
      ))}
    </section>
  );
}
