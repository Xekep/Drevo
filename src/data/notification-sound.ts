const key = (userId: string) =>
  `drevo:notification-sound:v1:${encodeURIComponent(userId)}`;

export function readNotificationSoundPreference(
  userId: string,
  storage?: Pick<Storage, "getItem">,
) {
  try {
    return (storage ?? window.localStorage).getItem(key(userId)) !== "off";
  } catch {
    return true;
  }
}

export function writeNotificationSoundPreference(
  userId: string,
  enabled: boolean,
  storage?: Pick<Storage, "setItem">,
) {
  try {
    (storage ?? window.localStorage).setItem(
      key(userId),
      enabled ? "on" : "off",
    );
  } catch {
    /* A private or restricted browser still supports the in-tab choice. */
  }
}

/** Audio is created/resumed only in a trusted gesture, never by a network response. */
export function createNotificationSound(
  target: Window | null = typeof window === "undefined" ? null : window,
) {
  let context: AudioContext | null = null;
  let disposed = false;
  const nodes = new Set<{ oscillator: OscillatorNode; gain: GainNode }>();
  const unlock = (event: Event) => {
    if (disposed || !event.isTrusted) return;
    if (event.type === "pointerdown" && (event as PointerEvent).button !== 0)
      return;
    if (
      event.type === "keydown" &&
      ((event as KeyboardEvent).repeat ||
        ["Shift", "Control", "Alt", "Meta"].includes(
          (event as KeyboardEvent).key,
        ))
    )
      return;
    try {
      const Audio = (
        target as (Window & { AudioContext?: typeof AudioContext }) | null
      )?.AudioContext;
      if (!context && Audio) context = new Audio();
      if (context && context.state !== "running")
        void context.resume().catch(() => {});
    } catch {
      /* Unsupported audio or autoplay restrictions do not affect the inbox. */
    }
  };
  target?.addEventListener("pointerdown", unlock);
  target?.addEventListener("keydown", unlock);
  return {
    play() {
      if (disposed || !context || context.state !== "running") return;
      try {
        const oscillator = context.createOscillator();
        const gain = context.createGain();
        const pair = { oscillator, gain };
        nodes.add(pair);
        oscillator.type = "sine";
        oscillator.frequency.setValueAtTime(680, context.currentTime);
        gain.gain.setValueAtTime(0.001, context.currentTime);
        gain.gain.exponentialRampToValueAtTime(
          0.018,
          context.currentTime + 0.015,
        );
        gain.gain.exponentialRampToValueAtTime(
          0.001,
          context.currentTime + 0.14,
        );
        oscillator.connect(gain);
        gain.connect(context.destination);
        oscillator.onended = () => {
          nodes.delete(pair);
          oscillator.disconnect();
          gain.disconnect();
        };
        oscillator.start();
        oscillator.stop(context.currentTime + 0.15);
      } catch {
        /* A sound failure must not fail a successful notification response. */
      }
    },
    dispose() {
      disposed = true;
      target?.removeEventListener("pointerdown", unlock);
      target?.removeEventListener("keydown", unlock);
      for (const { oscillator, gain } of nodes) {
        try {
          oscillator.stop();
          oscillator.disconnect();
          gain.disconnect();
        } catch {
          /* Already ended. */
        }
      }
      nodes.clear();
      try {
        if (context) void context.close().catch(() => {});
      } catch {
        /* Already closed. */
      }
      context = null;
    },
  };
}
