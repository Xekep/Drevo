import { useEffect, useRef, useState } from "react";

/** Owns slide dwell time and progress, preserving elapsed time across pauses. */
export function useChroniclePlayback(
  slideId: string,
  playing: boolean,
  paused: boolean,
  next: () => void,
  duration = 5000,
) {
  const elapsed = useRef({ slideId, ms: 0 });
  const [sample, setSample] = useState({ slideId, ms: 0 });
  useEffect(() => {
    if (elapsed.current.slideId !== slideId)
      elapsed.current = { slideId, ms: 0 };
    if (!playing || paused) return;
    const start = performance.now(),
      previous = elapsed.current.ms;
    const currentTime = () =>
      Math.min(duration, previous + performance.now() - start);
    const timer = setInterval(() => {
      const ms = currentTime();
      elapsed.current.ms = ms;
      setSample({ slideId, ms });
      if (ms >= duration) {
        clearInterval(timer);
        next();
      }
    }, 50);
    return () => {
      elapsed.current.ms = currentTime();
      clearInterval(timer);
    };
  }, [slideId, playing, paused, next, duration]);
  return sample.slideId === slideId ? Math.min(100, sample.ms / duration * 100) : 0;
}
