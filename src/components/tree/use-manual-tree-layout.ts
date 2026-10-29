import {
  useEffect,
  useRef,
  useState,
  type PointerEvent,
  type MouseEvent,
  type KeyboardEvent,
} from "react";
import type { TreeGeometry } from "../../domain/tree-layout";
import type { FamilyLink } from "../../domain/types";
import { moveDisplayedFamily } from "../../domain/manual-tree-layout";

type Saved = {
  original: TreeGeometry;
  key: string;
  geometry: TreeGeometry;
  undo: TreeGeometry[];
};
type Drag = {
  pointer: number;
  x: number;
  dx: number;
  zoom: number;
  id: string;
  geometry: TreeGeometry;
  saved: Saved | null;
};

/** Temporary print composition, isolated from persisted graph edits and camera state. */
export function useManualTreeLayout(
  original: TreeGeometry | null,
  key: string,
  available: boolean,
  links: FamilyLink[],
  getZoom: () => number,
  onStart: () => void,
) {
  const [enabled, setEnabled] = useState(false),
    [saved, setSaved] = useState<Saved | null>(null),
    [preview, setPreview] = useState<{
      original: TreeGeometry;
      key: string;
      pointer: number;
      geometry: TreeGeometry;
    } | null>(null);
  const drag = useRef<Drag | null>(null),
    frame = useRef<number | null>(null),
    suppressClick = useRef(false);
  const current =
    saved?.original === original && saved.key === key ? saved : null;
  const active = enabled && available;
  if (
    preview &&
    (!active || preview.original !== original || preview.key !== key)
  )
    setPreview(null);
  const geometry =
    active && preview?.original === original && preview.key === key
      ? preview.geometry
      : current?.geometry || original;
  useEffect(
    () => () => {
      if (frame.current !== null) cancelAnimationFrame(frame.current);
      frame.current = null;
      drag.current = null;
      suppressClick.current = false;
    },
    [original, key, active],
  );
  const commit = (
    next: TreeGeometry,
    before: TreeGeometry,
    prior = current,
  ) => {
    if (!original || next === before) return;
    setSaved({
      original,
      key,
      geometry: next,
      undo: [...(prior?.undo || []), before].slice(-20),
    });
  };
  const undo = () => {
    if (!current?.undo.length) return;
    setSaved({
      ...current,
      geometry: current.undo.at(-1)!,
      undo: current.undo.slice(0, -1),
    });
  };
  const person = (target: EventTarget) =>
    (target as Element)
      .closest(".flow-person-content")
      ?.closest(".react-flow__node-person")
      ?.getAttribute("data-id");
  const stopFrame = () => {
    if (frame.current !== null) cancelAnimationFrame(frame.current);
    frame.current = null;
  };
  const finish = (event: PointerEvent<HTMLDivElement>, cancel = false) => {
    const start = drag.current;
    if (!start || event.pointerId !== start.pointer) return false;
    event.preventDefault();
    event.stopPropagation();
    stopFrame();
    drag.current = null;
    setPreview(null);
    if (cancel) suppressClick.current = false;
    else {
      const next = moveDisplayedFamily(
        start.geometry,
        start.id,
        start.dx,
        true,
        links,
      );
      if (next !== start.geometry) commit(next, start.geometry, start.saved);
    }
    if (event.currentTarget.hasPointerCapture(event.pointerId))
      event.currentTarget.releasePointerCapture(event.pointerId);
    return true;
  };
  return {
    geometry,
    active,
    enabled,
    setEnabled,
    changed: !!current,
    canUndo: !!current?.undo.length,
    reset: () => setSaved(null),
    undo,
    onPointerDown(event: PointerEvent<HTMLDivElement>) {
      const id =
        active &&
        event.pointerType === "mouse" &&
        event.button === 0 &&
        person(event.target);
      if (!id || !geometry || drag.current) return false;
      event.preventDefault();
      event.stopPropagation();
      onStart();
      (event.target as HTMLElement)
        .closest<HTMLElement>(".flow-person-content")
        ?.focus();
      event.currentTarget.setPointerCapture(event.pointerId);
      suppressClick.current = true;
      drag.current = {
        pointer: event.pointerId,
        x: event.clientX,
        dx: 0,
        zoom: getZoom(),
        id,
        geometry,
        saved: current,
      };
      return true;
    },
    onPointerMove(event: PointerEvent<HTMLDivElement>) {
      const start = drag.current;
      if (!start || event.pointerId !== start.pointer) return false;
      event.preventDefault();
      event.stopPropagation();
      start.dx = (event.clientX - start.x) / start.zoom;
      if (frame.current === null)
        frame.current = requestAnimationFrame(() => {
          frame.current = null;
          if (!original || drag.current !== start) return;
          setPreview({
            original,
            key,
            pointer: start.pointer,
            geometry: moveDisplayedFamily(start.geometry, start.id, start.dx),
          });
        });
      return true;
    },
    onPointerUp: (event: PointerEvent<HTMLDivElement>) => finish(event),
    onPointerCancel: (event: PointerEvent<HTMLDivElement>) =>
      finish(event, true),
    onMouseDown(event: MouseEvent<HTMLDivElement>) {
      if (active && event.button === 0 && person(event.target)) {
        event.preventDefault();
        event.stopPropagation();
        return true;
      }
      return false;
    },
    onClick(event: MouseEvent<HTMLDivElement>) {
      if (suppressClick.current || (active && person(event.target))) {
        suppressClick.current = false;
        event.preventDefault();
        event.stopPropagation();
        return true;
      }
      return false;
    },
    onKeyDown(event: KeyboardEvent<HTMLDivElement>) {
      if (
        !active ||
        (event.target as HTMLElement).matches("input,textarea,select")
      )
        return;
      const id = person(event.target);
      if (event.key === "Escape") {
        const start = drag.current;
        if (start) {
          stopFrame();
          drag.current = null;
          setPreview(null);
          suppressClick.current = false;
          if (event.currentTarget.hasPointerCapture(start.pointer))
            event.currentTarget.releasePointerCapture(start.pointer);
        }
        setEnabled(false);
        event.preventDefault();
        event.stopPropagation();
      } else if (
        (event.ctrlKey || event.metaKey) &&
        event.key.toLowerCase() === "z"
      ) {
        undo();
        event.preventDefault();
        event.stopPropagation();
      } else if (
        id &&
        geometry &&
        ["ArrowLeft", "ArrowRight"].includes(event.key)
      ) {
        event.preventDefault();
        event.stopPropagation();
        onStart();
        commit(
          moveDisplayedFamily(
            geometry,
            id,
            (event.key === "ArrowLeft" ? -1 : 1) * (event.shiftKey ? 5 : 20),
            true,
            links,
          ),
          geometry,
        );
      }
    },
  };
}
