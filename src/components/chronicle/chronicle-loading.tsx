import { useEffect, useRef } from "react";

/** Dot-ring preloader adapted from filipz's Liquid Morphology Slideshow (MIT).
 * Notice: public/licenses/liquid-morphology-MIT.txt. Runs only while loading. */
export function ChronicleLoading({
  label = "Загружаем хронику…",
}: {
  label?: string;
}) {
  const canvas = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const node = canvas.current!,
      context = node.getContext("2d");
    if (!context) return;
    const ratio = Math.min(window.devicePixelRatio || 1, 2);
    node.width = node.height = 300 * ratio;
    context.setTransform(ratio, 0, 0, ratio, 0, 0);
    const preference = matchMedia("(prefers-reduced-motion: reduce)");
    const rings = [
      { radius: 20, count: 8 },
      { radius: 35, count: 12 },
      { radius: 50, count: 16 },
      { radius: 65, count: 20 },
      { radius: 80, count: 24 },
    ];
    const sine = (t: number) => -(Math.cos(Math.PI * t) - 1) / 2;
    let frame = 0,
      origin: number | undefined;
    function draw(now: number) {
      origin ??= now;
      const time = preference.matches ? 0 : (now - origin) / 1000;
      context!.clearRect(0, 0, 300, 300);
      context!.beginPath();
      context!.arc(150, 150, 3, 0, Math.PI * 2);
      context!.fillStyle = "rgba(255,255,255,0.9)";
      context!.fill();
      rings.forEach((ring, ringIndex) => {
        const pulseTime = time * 2 - ringIndex * 0.4;
        const radiusPulse = sine((Math.sin(pulseTime) + 1) / 2) * 6 - 3;
        const phase = (Math.sin(pulseTime) + 1) / 2;
        const highlight =
          phase < 0.5 ? 4 * phase ** 3 : 1 - (-2 * phase + 2) ** 3 / 2;
        const blend = Math.max(0, Math.min(1, (highlight - 0.2) / 0.6));
        const gray = Math.round(255 - 34 * blend * blend * (3 - 2 * blend));
        for (let i = 0; i < ring.count; i++) {
          const angle = (i / ring.count) * Math.PI * 2;
          const opacity =
            0.3 + sine((Math.sin(pulseTime + i * 0.2) + 1) / 2) * 0.7;
          context!.beginPath();
          context!.arc(
            150 + Math.cos(angle) * (ring.radius + radiusPulse),
            150 + Math.sin(angle) * (ring.radius + radiusPulse),
            2,
            0,
            Math.PI * 2,
          );
          context!.fillStyle = `rgba(${gray},${gray},${gray},${opacity})`;
          context!.fill();
        }
      });
      if (!preference.matches && !document.hidden)
        frame = requestAnimationFrame(draw);
    }
    function resume() {
      cancelAnimationFrame(frame);
      draw(performance.now());
    }
    resume();
    preference.addEventListener("change", resume);
    document.addEventListener("visibilitychange", resume);
    return () => {
      cancelAnimationFrame(frame);
      preference.removeEventListener("change", resume);
      document.removeEventListener("visibilitychange", resume);
    };
  }, []);
  return (
    <div className="chronicle-loading" role="status">
      <canvas ref={canvas} aria-hidden="true" />
      <p>{label}</p>
    </div>
  );
}
