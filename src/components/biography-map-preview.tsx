import { useEffect, useRef } from "react";
import { parseBiographyMap } from "../domain/biography-map";
import "../styles/biography-map.css";

export type BiographyMapActions = {
  onOpen: (source: string) => void;
  onEdit?: (source: string, range?: { from: number; to: number }) => void;
  onSource?: () => void;
};

/** Shared DOM preview for the Markdown renderer and CodeMirror widgets. */
export function mountBiographyMapPreview(
  host: HTMLElement,
  source: string,
  actions: BiographyMapActions,
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
    if (actions.onSource) {
      const edit = document.createElement("button");
      edit.type = "button";
      edit.textContent = "Исправить код карты";
      edit.onclick = (event) => {
        event.preventDefault();
        event.stopPropagation();
        actions.onSource!();
      };
      host.append(edit);
    }
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
  if (actions.onEdit) button("Изменить карту", () => actions.onEdit!(source));
  if (actions.onSource) button("Код", actions.onSource);
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
  useEffect(
    () => mountBiographyMapPreview(host.current!, source, { onOpen }),
    [source, onOpen],
  );
  return <div ref={host} />;
}
