import assert from "node:assert/strict";
import test from "node:test";
import {
  createNotificationSound,
  readNotificationSoundPreference,
  writeNotificationSoundPreference,
} from "../src/data/notification-sound.ts";

test("sound preferences default on, are isolated by account, and tolerate blocked storage", () => {
  const records = new Map<string, string>();
  const storage = {
    getItem: (key: string) => records.get(key) ?? null,
    setItem: (key: string, value: string) => {
      records.set(key, value);
    },
  };
  assert.equal(readNotificationSoundPreference("first", storage), true);
  writeNotificationSoundPreference("first", false, storage);
  assert.equal(readNotificationSoundPreference("first", storage), false);
  assert.equal(readNotificationSoundPreference("second", storage), true);
  writeNotificationSoundPreference("first", true, storage);
  assert.equal(readNotificationSoundPreference("first", storage), true);
  assert.equal(
    readNotificationSoundPreference("first", {
      getItem() {
        throw new Error("private storage");
      },
    }),
    true,
  );
  assert.doesNotThrow(() =>
    writeNotificationSoundPreference("first", false, {
      setItem() {
        throw new Error("private storage");
      },
    }),
  );
});

function soundFixture() {
  const listeners = new Map<string, EventListener>();
  const stats = {
    created: 0,
    resumed: 0,
    played: 0,
    closed: 0,
    gains: [] as number[],
    stops: [] as number[],
  };
  class Audio {
    state = "suspended";
    currentTime = 10;
    destination = {};
    constructor() {
      stats.created++;
    }
    resume() {
      stats.resumed++;
      this.state = "running";
      return Promise.resolve();
    }
    close() {
      stats.closed++;
      this.state = "closed";
      return Promise.resolve();
    }
    createOscillator() {
      return {
        type: "",
        frequency: { setValueAtTime() {} },
        onended: null,
        connect() {},
        disconnect() {},
        start() {
          stats.played++;
        },
        stop(time: number) {
          stats.stops.push(time);
        },
      };
    }
    createGain() {
      return {
        gain: {
          setValueAtTime(value: number) {
            stats.gains.push(value);
          },
          exponentialRampToValueAtTime(value: number) {
            stats.gains.push(value);
          },
        },
        connect() {},
        disconnect() {},
      };
    }
  }
  const target = {
    AudioContext: Audio,
    addEventListener: (name: string, listener: EventListener) =>
      listeners.set(name, listener),
    removeEventListener: (name: string) => listeners.delete(name),
  } as unknown as Window;
  const event = (type: string, fields: Record<string, unknown> = {}) =>
    listeners.get(type)?.({
      type,
      isTrusted: true,
      button: 0,
      key: "Enter",
      ...fields,
    } as unknown as Event);
  return { target, stats, event, listeners };
}

test("notification audio unlocks only through trusted interaction and remains brief and quiet", () => {
  const fixture = soundFixture();
  const sound = createNotificationSound(fixture.target);
  sound.play();
  fixture.event("pointerdown", { isTrusted: false });
  fixture.event("pointerdown", { button: 2 });
  fixture.event("keydown", { key: "Shift" });
  fixture.event("keydown", { repeat: true });
  assert.equal(fixture.stats.created, 0);
  fixture.event("keydown");
  assert.equal(fixture.stats.created, 1);
  assert.equal(fixture.stats.resumed, 1);
  sound.play();
  assert.equal(fixture.stats.played, 1);
  assert.ok(Math.max(...fixture.stats.gains) <= 0.018);
  assert.equal(fixture.stats.stops[0], 10.15);
  sound.dispose();
  assert.equal(fixture.listeners.size, 0);
  assert.equal(fixture.stats.closed, 1);
  sound.play();
  fixture.event("pointerdown");
  assert.equal(fixture.stats.played, 1);
  assert.equal(fixture.stats.created, 1);
  sound.dispose();
  assert.equal(fixture.stats.closed, 1);
});

test("unsupported or failing WebAudio does not break notification work", () => {
  const fixture = soundFixture();
  Object.defineProperty(fixture.target, "AudioContext", {
    value: class {
      constructor() {
        throw new Error("audio disabled");
      }
    },
  });
  const sound = createNotificationSound(fixture.target);
  assert.doesNotThrow(() => {
    fixture.event("pointerdown");
    sound.play();
    sound.dispose();
  });
  assert.doesNotThrow(() => {
    const silent = createNotificationSound(null);
    silent.play();
    silent.dispose();
  });
});
