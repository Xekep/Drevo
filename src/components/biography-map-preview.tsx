import { useEffect, useLayoutEffect, useRef } from "react";
import { parseBiographyMap } from "../domain/biography-map";
import "../styles/biography-map.css";

/** Read-only mini-map for a saved biography. Editing uses a source icon. */
export function mountBiographyMapPreview(
  host: HTMLElement,
  source: string,
  actions: { onOpen: (source: string) => void },
) {
  let disposed = false,
    destroy: (() => void) | undefined;
  host.classList.add("biography-map-preview");
  const canvas = document.createElement("div"),
    controls = document.createElement("div");
  canvas.className = "biography-map-mini";
  controls.className = "biography-map-actions";
  let data;
  try {
    data = parseBiographyMap(source);
  } catch (reason) {
    host.textContent =
      reason instanceof Error ? reason.message : "Не удалось показать карту";
    const code = document.createElement("pre");
    code.textContent = source;
    host.append(code);
    return () => host.replaceChildren();
  }
  const title = data.name || "Карта жизни";
  canvas.setAttribute("role", "button");
  canvas.tabIndex = 0;
  canvas.setAttribute("aria-label", `Открыть карту: ${title}`);
  canvas.addEventListener("click", (event) => {
    if (!(event.target as Element).closest("a")) actions.onOpen(source);
  });
  canvas.addEventListener("keydown", (event) => {
    if (event.target === canvas && ["Enter", " "].includes(event.key)) {
      event.preventDefault();
      actions.onOpen(source);
    }
  });
  const button = (text: string, action: () => void) => {
    const node = document.createElement("button");
    node.type = "button";
    node.textContent = text;
    node.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      action();
    });
    controls.append(node);
  };
  button(title + " · Развернуть", () => actions.onOpen(source));
  host.append(canvas, controls);
  const load = () => {
    void import("./biography-map-surface")
      .then(({ mountBiographyMap }) => {
        if (!disposed)
          destroy = mountBiographyMap(canvas, data, {
            interactive: false,
          }).destroy;
      })
      .catch(() => {
        if (!disposed)
          canvas.textContent =
            "Не удалось загрузить подложку карты. Откройте карту ещё раз.";
      });
  };
  const observer =
    typeof IntersectionObserver === "undefined"
      ? null
      : new IntersectionObserver((entries) => {
          if (entries.some((entry) => entry.isIntersecting)) {
            observer?.disconnect();
            load();
          }
        });
  if (observer) observer.observe(canvas);
  else load();
  return () => {
    disposed = true;
    observer?.disconnect();
    destroy?.();
    host.replaceChildren();
  };
}

export function BiographyMapPreview({
  source,
  onOpen,
}: {
  source: string;
  onOpen: (source: string) => void;
}) {
  const host = useRef<HTMLDivElement>(null);
  const open = useRef(onOpen);
  useLayoutEffect(() => { open.current = onOpen; }, [onOpen]);
  useEffect(
    () => mountBiographyMapPreview(host.current!, source, { onOpen: value => open.current(value) }),
    [source],
  );
  return <div ref={host} />;
}
