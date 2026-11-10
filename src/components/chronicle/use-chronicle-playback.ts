import { useEffect, useRef, useState } from "react";

/** Owns slide dwell time and progress, preserving elapsed time across pauses. */
export function useChroniclePlayback(
  slideId: string,
  playing: boolean,
  paused: boolean,
  next: () => void,
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
      Math.min(5000, previous + performance.now() - start);
    const timer = setInterval(() => {
      const ms = currentTime();
      elapsed.current.ms = ms;
      setSample({ slideId, ms });
      if (ms >= 5000) {
        clearInterval(timer);
        next();
      }
    }, 50);
    return () => {
      elapsed.current.ms = currentTime();
      clearInterval(timer);
    };
  }, [slideId, playing, paused, next]);
  return sample.slideId === slideId ? sample.ms / 50 : 0;
}
