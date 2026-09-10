import { useRef, useState } from "react";
import { EditorDialog } from "./editor-dialog";
import { portraitCrop } from "../domain/portrait-crop";

export function PortraitCropper({
  src,
  onClose,
  onCrop,
}: {
  src: string;
  onClose: () => void;
  onCrop: (file: File) => void;
}) {
  const image = useRef<HTMLImageElement>(null),
    area = useRef<HTMLButtonElement>(null);
  const [size, setSize] = useState({ width: 1, height: 1 }),
    [zoom, setZoom] = useState(1),
    [center, setCenter] = useState({ x: 0.5, y: 0.5 }),
    [ready, setReady] = useState(false),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false);
  const drag = useRef<{ x: number; y: number; cx: number; cy: number } | null>(
    null,
  );
  const crop = portraitCrop(size.width, size.height, zoom, center.x, center.y);
  return (
    <EditorDialog title="Обрезать портрет" onClose={onClose} wide>
      <div className="portrait-cropper">
        <p>
          Переместите снимок и измените масштаб. В портрете останется квадратная
          область.
        </p>
        <button
          ref={area}
          type="button"
          className="portrait-crop-area"
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
            setCenter({
              x: Math.max(
                0,
                Math.min(
                  1,
                  start.cx - ((event.clientX - start.x) * ratio) / size.width,
                ),
              ),
              y: Math.max(
                0,
                Math.min(
                  1,
                  start.cy - ((event.clientY - start.y) * ratio) / size.height,
                ),
              ),
            });
          }}
          onPointerUp={() => {
            drag.current = null;
          }}
          onPointerCancel={() => {
            drag.current = null;
          }}
          onKeyDown={(event) => {
            if (!event.key.startsWith("Arrow")) return;
            event.preventDefault();
            setCenter({
              x: Math.max(
                0,
                Math.min(
                  1,
                  (crop.x +
                    crop.width / 2 +
                    (event.key === "ArrowLeft"
                      ? -crop.width / 20
                      : event.key === "ArrowRight"
                        ? crop.width / 20
                        : 0)) /
                    size.width,
                ),
              ),
              y: Math.max(
                0,
                Math.min(
                  1,
                  (crop.y +
                    crop.height / 2 +
                    (event.key === "ArrowUp"
                      ? -crop.width / 20
                      : event.key === "ArrowDown"
                        ? crop.width / 20
                        : 0)) /
                    size.height,
                ),
              ),
            });
          }}
        >
          <img
            ref={image}
            src={src}
            alt=""
            draggable={false}
            onLoad={(event) => {
              setSize({
                width: event.currentTarget.naturalWidth,
                height: event.currentTarget.naturalHeight,
              });
              setReady(true);
            }}
            onError={() => setError("Не удалось открыть снимок")}
            style={{
              width: `${(size.width / crop.width) * 100}%`,
              height: `${(size.height / crop.height) * 100}%`,
              left: `${(-crop.x / crop.width) * 100}%`,
              top: `${(-crop.y / crop.height) * 100}%`,
            }}
          />
        </button>
        <label>
          Масштаб{" "}
          <input
            type="range"
            min="1"
            max="6"
            step="0.02"
            value={zoom}
            onChange={(event) => setZoom(Number(event.target.value))}
          />
        </label>
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
              ctx.drawImage(
                image.current,
                crop.x,
                crop.y,
                crop.width,
                crop.height,
                0,
                0,
                640,
                640,
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
