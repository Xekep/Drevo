import { useId, useRef, useState } from "react";
import { EditorDialog } from "./editor-dialog";
import {
  portraitCrop,
  portraitImageDelta,
  portraitInitialFraming,
  type PortraitRegion,
} from "../domain/portrait-crop";
import { RotateCcw } from "lucide-react";
import { archiveResourceUrl } from "../domain/archive-context.ts";

export function PortraitCropper({
  src,
  region,
  onClose,
  onCrop,
}: {
  src: string;
  region?: PortraitRegion;
  onClose: () => void;
  onCrop: (file: File) => void;
}) {
  const rotationId = useId();
  const image = useRef<HTMLImageElement>(null),
    area = useRef<HTMLButtonElement>(null);
  const [size, setSize] = useState({ width: 1, height: 1 }),
    [zoom, setZoom] = useState(1),
    [rotation, setRotation] = useState(0),
    [center, setCenter] = useState({ x: 0.5, y: 0.5 }),
    [ready, setReady] = useState(false),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false);
  const drag = useRef<{ x: number; y: number; cx: number; cy: number } | null>(
    null,
  );
  const initial = portraitInitialFraming(size.width, size.height, region);
  const crop = portraitCrop(
    size.width,
    size.height,
    zoom,
    center.x,
    center.y,
    rotation,
    initial.maxZoom,
  );
  const moveCenter = (dx: number, dy: number) => {
    const delta = portraitImageDelta(dx, dy, rotation);
    setCenter({
      x: (crop.x + crop.width / 2 + delta.x) / size.width,
      y: (crop.y + crop.height / 2 + delta.y) / size.height,
    });
  };
  return (
    <EditorDialog title="Обрезать портрет" onClose={onClose} className="portrait-crop-dialog">
      <div className="portrait-cropper">
        <p>
          Подвиньте снимок и настройте масштаб и поворот.
        </p>
        <button
          ref={area}
          type="button"
          className="portrait-crop-area"
          disabled={!ready || busy}
          aria-label="Область портрета. Перетаскивайте снимок или используйте стрелки клавиатуры."
          onPointerDown={(event) => {
            if (!ready) return;
            event.preventDefault();
            event.currentTarget.focus();
            event.currentTarget.setPointerCapture(event.pointerId);
            drag.current = {
              x: event.clientX,
              y: event.clientY,
              cx: (crop.x + crop.width / 2) / size.width,
              cy: (crop.y + crop.height / 2) / size.height,
            };
          }}
          onPointerMove={(event) => {
            const start = drag.current;
            if (!start || !area.current) return;
            const ratio = crop.width / area.current.clientWidth;
            const delta = portraitImageDelta(
              (event.clientX - start.x) * ratio,
              (event.clientY - start.y) * ratio,
              rotation,
            );
            setCenter({
              x: start.cx - delta.x / size.width,
              y: start.cy - delta.y / size.height,
            });
          }}
          onPointerUp={() => {
            drag.current = null;
          }}
          onPointerCancel={() => {
            drag.current = null;
          }}
          onLostPointerCapture={() => {
            drag.current = null;
          }}
          onKeyDown={(event) => {
            if (!event.key.startsWith("Arrow")) return;
            event.preventDefault();
            moveCenter(
              event.key === "ArrowLeft"
                ? -crop.width / 20
                : event.key === "ArrowRight"
                  ? crop.width / 20
                  : 0,
              event.key === "ArrowUp"
                ? -crop.width / 20
                : event.key === "ArrowDown"
                  ? crop.width / 20
                  : 0,
            );
          }}
        >
          <img
            ref={image}
            src={archiveResourceUrl(src)}
            alt=""
            draggable={false}
            onLoad={(event) => {
              const nextSize = {
                width: event.currentTarget.naturalWidth,
                height: event.currentTarget.naturalHeight,
              };
              const framing = portraitInitialFraming(
                nextSize.width,
                nextSize.height,
                region,
              );
              setSize(nextSize);
              setZoom(framing.zoom);
              setCenter(framing.center);
              setRotation(0);
              setReady(true);
            }}
            onError={() => {
              setReady(false);
              setError("Не удалось открыть снимок");
            }}
            style={{
              width: `${(size.width / crop.width) * 100}%`,
              height: `${(size.height / crop.height) * 100}%`,
              left: `${(-crop.x / crop.width) * 100}%`,
              top: `${(-crop.y / crop.height) * 100}%`,
              transformOrigin: `${((crop.x + crop.width / 2) / size.width) * 100}% ${((crop.y + crop.height / 2) / size.height) * 100}%`,
              transform: `rotate(${rotation}deg)`,
              visibility: ready ? "visible" : "hidden",
            }}
          />
        </button>
        <div className="portrait-crop-controls">
          <label>
            <span>Масштаб</span>
            <input
              type="range"
              min="1"
              max={initial.maxZoom}
              step="any"
              value={zoom}
              disabled={!ready || busy}
              onChange={(event) => setZoom(Number(event.target.value))}
            />
          </label>
          <label htmlFor={rotationId}>
            <span>
              Поворот <output>{rotation}°</output>
            </span>
            <input
              type="range"
              id={rotationId}
              aria-valuetext={`${rotation} градусов`}
              min="-180"
              max="180"
              step="1"
              value={rotation}
              disabled={!ready || busy}
              onChange={(event) => {
                // Retain the actual centre when a previous move reached an edge.
                setCenter({
                  x: (crop.x + crop.width / 2) / size.width,
                  y: (crop.y + crop.height / 2) / size.height,
                });
                setRotation(Number(event.target.value));
              }}
            />
          </label>
          <button
            type="button"
            className="text-action portrait-crop-reset"
            disabled={!ready || busy}
            onClick={() => {
              setZoom(initial.zoom);
              setCenter(initial.center);
              setRotation(0);
            }}
          >
            <RotateCcw size={15} aria-hidden="true" /> Сбросить
          </button>
        </div>
        {error && (
          <p className="form-error" role="alert">
            {error}
          </p>
        )}
        <button
          type="button"
          className="primary-action"
          disabled={!ready || busy}
          onClick={async () => {
            if (!image.current) return;
            setBusy(true);
            setError("");
            try {
              const canvas = document.createElement("canvas");
              canvas.width = canvas.height = 640;
              const ctx = canvas.getContext("2d")!;
              ctx.fillStyle = "#fff";
              ctx.fillRect(0, 0, 640, 640);
              ctx.translate(320, 320);
              ctx.rotate((rotation * Math.PI) / 180);
              ctx.scale(640 / crop.width, 640 / crop.height);
              ctx.drawImage(
                image.current,
                -crop.x - crop.width / 2,
                -crop.y - crop.height / 2,
              );
              const blob = await new Promise<Blob>((resolve, reject) =>
                canvas.toBlob(
                  (value) =>
                    value
                      ? resolve(value)
                      : reject(new Error("Не удалось сохранить обрезку")),
                  "image/png",
                ),
              );
              onCrop(new File([blob], "portrait.png", { type: "image/png" }));
            } catch {
              setError(
                "Не удалось обрезать снимок. Попробуйте выбрать другую фотографию.",
              );
            } finally {
              setBusy(false);
            }
          }}
        >
          Использовать портрет
        </button>
      </div>
    </EditorDialog>
  );
}
