import { lazy, Suspense, useEffect, useRef, useState } from "react";
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
  const pointsList = useRef<HTMLDetailsElement>(null);
  const [focus, setFocus] = useState<{ data: BiographyMap; index: number } | null>(null);
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
      <div className="biography-map-body">
        {data.features.some(
          (f) => !f.geometry || f.geometry.type === "Point",
        ) && (
          <details ref={pointsList} className="biography-map-points-list">
            <summary>Точки маршрута</summary>
            <ol>
              {data.features
                .map((f, index) => ({ f, index }))
                .filter(({ f }) => !f.geometry || f.geometry.type === "Point")
                .map(({ f, index }, i) => (
                  <li key={index}>
                    <button type="button" className="biography-map-point" disabled={!f.geometry}
                      onClick={() => {
                        setFocus({ data, index });
                        if (pointsList.current) pointsList.current.open = false;
                      }}>
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
                    </button>
                    {!f.geometry && <span>Место не привязано к карте</span>}
                    {typeof f.properties.description === "string" && (
                      <p>{f.properties.description}</p>
                    )}
                  </li>
                ))}
            </ol>
          </details>
        )}
        <Suspense fallback={<p role="status">Загрузка карты…</p>}>
          <Surface data={data} focus={focus?.data === data ? focus : null} />
        </Suspense>
      </div>
    </section>
  );
}
