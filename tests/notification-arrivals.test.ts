import assert from "node:assert/strict";
import test from "node:test";
import {
  combineNotificationPages,
  notificationArrival,
} from "../src/domain/notification-arrivals.ts";
import type { ArchiveNotificationsPage } from "../src/shared/archive-notifications.ts";

const page = (
  ids: number[],
  latest = 0,
  next: number | null = null,
): ArchiveNotificationsPage => ({
  unread: latest ? 1 : 0,
  latest,
  next,
  items: ids.map((id) => ({
    id,
    at: "2026-10-11T12:00:00Z",
    kind: "person_added",
    personId: `person-${id}`,
    personName: "Test",
    actorName: "Actor",
    read: id !== latest,
  })),
});

test("first inbox is silent and read receipts cannot lower the arrival watermark", () => {
  const initial = notificationArrival(null, page([100, 99], 99));
  assert.deepEqual(initial, { highWater: 100, sound: false });
  assert.deepEqual(notificationArrival(initial.highWater, page([100, 99], 0)), {
    highWater: 100,
    sound: false,
  });
  assert.deepEqual(notificationArrival(100, page([100, 99], 99)), {
    highWater: 100,
    sound: false,
  });
  const fresh = notificationArrival(100, page([102, 101, 100], 102));
  assert.deepEqual(fresh, { highWater: 102, sound: true });
  assert.equal(
    notificationArrival(fresh.highWater, page([102, 101], 102)).sound,
    false,
  );
  assert.equal(
    notificationArrival(fresh.highWater, page([99, 98], 102)).sound,
    false,
    "pagination's global unread max is not a new arrival",
  );
});

test("already read new ids advance silently, while an unread arrival outside a fetched page is detected", () => {
  assert.deepEqual(notificationArrival(100, page([105, 104])), {
    highWater: 105,
    sound: false,
  });
  assert.deepEqual(notificationArrival(105, page([100, 99], 108)), {
    highWater: 108,
    sound: true,
  });
  const unread = page([110]);
  unread.items[0].read = false;
  assert.equal(notificationArrival(108, unread).sound, true);
});

test("revalidated pages retain loaded range without duplicates or ineligible cached rows", () => {
  const head = page([202, 201, 200, 199], 202, 199);
  const tail = page([199, 198, 196, 195, 194], 201, 194);
  tail.items[0].read = true;
  const combined = combineNotificationPages([head, tail], 195);
  assert.deepEqual(
    combined.items.map((item) => item.id),
    [202, 201, 200, 199, 198, 196, 195],
  );
  assert.equal(combined.items.find((item) => item.id === 199)?.read, true);
  assert.equal(
    combined.items.some((item) => item.id === 197),
    false,
    "a previously loaded but now inaccessible record is not retained",
  );
  assert.equal(
    combined.next,
    195,
    "trimmed page resumes below the actual rendered range",
  );
  assert.equal(combined.latest, 201);
});

test("when old loaded range disappears, fresh eligible older events remain usable", () => {
  const fresh = page([94, 93, 92], 94, 92);
  assert.deepEqual(combineNotificationPages([fresh], 95), fresh);
  assert.deepEqual(combineNotificationPages([page([])], 95), page([]));
  assert.deepEqual(
    combineNotificationPages([fresh]),
    fresh,
    "closed polling uses only the current head",
  );
});
