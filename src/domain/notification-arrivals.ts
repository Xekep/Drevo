import type { ArchiveNotificationsPage } from "../shared/archive-notifications.ts";

/** `latest` is the newest unread id, not the archive's overall event cursor. */
export function notificationArrival(
  previous: number | null,
  page: ArchiveNotificationsPage,
) {
  const observed = Math.max(
    0,
    page.latest,
    ...page.items.map((item) => item.id),
  );
  return {
    highWater: Math.max(previous ?? 0, observed),
    sound:
      previous !== null &&
      (page.latest > previous ||
        page.items.some((item) => !item.read && item.id > previous)),
  };
}

/** Freshly revalidated pages replace stale records while retaining the loaded range. */
export function combineNotificationPages(
  pages: ArchiveNotificationsPage[],
  floor = 0,
): ArchiveNotificationsPage {
  const last = pages.at(-1)!;
  const byId = new Map(
    pages.flatMap((page) => page.items).map((item) => [item.id, item]),
  );
  const all = [...byId.values()].sort((a, b) => b.id - a.id);
  const retained = floor ? all.filter((item) => item.id >= floor) : all;
  // If the previously loaded range became ineligible, show the new eligible
  // head and its cursor rather than an empty inbox with a nonzero badge.
  const items = retained.length || !all.length ? retained : all;
  return {
    items,
    unread: pages[0].unread,
    latest: pages[0].latest,
    next: all.length > items.length ? (items.at(-1)?.id ?? null) : last.next,
  };
}
