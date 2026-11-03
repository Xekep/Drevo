import { lazy, Suspense, useEffect, useRef } from "react";
import type { BiographyMap } from "../domain/biography-map";
import "../styles/biography-map.css";
const Surface = lazy(() => import("./biography-map-surface"));

export default function BiographyMapWorkspace({
  data,
  onClose,
  returnLabel = "Вернуться к древу",
}: {
  data: BiographyMap;
  onClose: () => void;
  returnLabel?: string;
}) {
  const close = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    const previous = document.activeElement;
    close.current?.focus();
    return () => {
      requestAnimationFrame(() => {
        if (previous instanceof HTMLElement && previous.isConnected)
          previous.focus();
      });
    };
  }, []);
  useEffect(() => {
    const escape = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.defaultPrevented) return;
      event.preventDefault();
      onClose();
    };
    document.addEventListener("keydown", escape);
    return () => document.removeEventListener("keydown", escape);
  }, [onClose]);
  return (
    <section
      className="biography-map-workspace"
      aria-label="Карта из биографии"
    >
      <header>
        <h2>{data.name || "Карта жизни"}</h2>
        <button ref={close} type="button" onClick={onClose}>
          {returnLabel}
        </button>
      </header>
      {data.features.some((f) => f.geometry.type === "Point") && (
        <details className="biography-map-points-list">
          <summary>Точки маршрута</summary>
          <ol>
            {data.features
              .filter((f) => f.geometry.type === "Point")
              .map((f, i) => (
                <li key={i}>
                  <strong>
                    {String(
                      f.properties.name ||
                        f.properties.title ||
                        `Точка ${i + 1}`,
                    )}
                  </strong>
                  {typeof f.properties.date === "string" && (
                    <span>{f.properties.date}</span>
                  )}
                  {typeof f.properties.description === "string" && (
                    <p>{f.properties.description}</p>
                  )}
                </li>
              ))}
          </ol>
        </details>
      )}
      <Suspense fallback={<p role="status">Загрузка карты…</p>}>
        <Surface data={data} />
      </Suspense>
    </section>
  );
}
