import { lazy, Suspense, useRef, useState } from "react";
import { ArrowDown, ArrowUp, Trash2 } from "lucide-react";
import {
  biographyMapRoute,
  BIOGRAPHY_MAP_LIMIT,
  parseBiographyMap,
  type BiographyMap,
} from "../domain/biography-map";
import { PersonDetailDialog } from "./person-detail-dialog";
import { confirmDiscardChanges } from "../hooks/useUnsavedChanges";
import "../styles/biography-map.css";
const Surface = lazy(() => import("./biography-map-surface"));

export default function BiographyMapEditor({
  initial,
  onApply,
  onClose,
  onDirtyChange,
}: {
  initial: BiographyMap;
  onApply: (data: BiographyMap) => void;
  onClose: () => void;
  onDirtyChange?: (dirty: boolean) => void;
}) {
  const [data, setData] = useState(initial),
    [connect, setConnect] = useState(
      initial.features.some((f) => f.properties.drevoRoute === true),
    );
  const [picking, setPicking] = useState(true),
    [error, setError] = useState("");
  const [latitude, setLatitude] = useState(""),
    [longitude, setLongitude] = useState("");
  const file = useRef<HTMLInputElement>(null);
  const dirty = JSON.stringify(data) !== JSON.stringify(initial);
  const pointIndices = data.features.flatMap((f, i) =>
    f.geometry.type === "Point" ? [i] : [],
  );
  const change = (next: BiographyMap) => {
    setData(biographyMapRoute(next, connect));
    setError("");
  };
  const add = (lon: number, lat: number) => {
    if (pointIndices.length >= 200) {
      setError("В редакторе можно поставить до 200 точек.");
      return;
    }
    change({
      ...data,
      features: [
        ...data.features,
        {
          type: "Feature",
          properties: { name: `Точка ${pointIndices.length + 1}` },
          geometry: { type: "Point", coordinates: [lon, lat] },
        },
      ],
    });
  };
  const move = (at: number, delta: number) => {
    const other = pointIndices[pointIndices.indexOf(at) + delta];
    if (other === undefined) return;
    const features = [...data.features];
    [features[at], features[other]] = [features[other], features[at]];
    change({ ...data, features });
  };
  return (
    <PersonDetailDialog
      title="Карта жизни"
      className="biography-map-editor"
      dirty={dirty}
      onDirtyChange={onDirtyChange}
      onClose={() => {
        if (confirmDiscardChanges(dirty)) onClose();
      }}
      onApply={() => onApply(parseBiographyMap(JSON.stringify(data)))}
    >
      <label>
        Название карты
        <input
          value={data.name || ""}
          maxLength={200}
          placeholder="Боевой путь"
          onChange={(e) => change({ ...data, name: e.target.value })}
        />
      </label>
      <div className="biography-map-editor-tools">
        <label>
          <input
            type="checkbox"
            checked={picking}
            onChange={(e) => setPicking(e.target.checked)}
          />
          Ставить точки нажатием на карту
        </label>
        <label>
          <input
            type="checkbox"
            checked={connect}
            onChange={(e) => {
              setConnect(e.target.checked);
              setData(biographyMapRoute(data, e.target.checked));
            }}
          />
          Соединить точки по порядку
        </label>
        <button type="button" onClick={() => file.current?.click()}>
          Загрузить GeoJSON
        </button>
        <input
          ref={file}
          type="file"
          hidden
          accept=".geojson,.json,application/geo+json,application/json"
          aria-label="Файл GeoJSON"
          onChange={async (e) => {
            const selected = e.target.files?.[0];
            e.target.value = "";
            if (!selected) return;
            try {
              if (selected.size > BIOGRAPHY_MAP_LIMIT * 4)
                throw new Error("Файл карты слишком большой.");
              const imported = parseBiographyMap(await selected.text());
              setData(imported);
              setConnect(
                imported.features.some((f) => f.properties.drevoRoute === true),
              );
              setError("");
            } catch (reason) {
              setError(
                reason instanceof Error
                  ? reason.message
                  : "Не удалось прочитать карту",
              );
            }
          }}
        />
      </div>
      <Suspense fallback={<p role="status">Загрузка карты…</p>}>
        <Surface data={data} onPoint={picking ? add : undefined} />
      </Suspense>
      <p>
        Нажмите на карту или укажите координаты. Названия и даты появятся у
        точек. Маршрут следует порядку в списке.
      </p>
      <div className="biography-map-editor-tools">
        <label>
          Широта
          <input
            type="number"
            step="any"
            min={-90}
            max={90}
            value={latitude}
            onChange={(e) => setLatitude(e.target.value)}
          />
        </label>
        <label>
          Долгота
          <input
            type="number"
            step="any"
            min={-180}
            max={180}
            value={longitude}
            onChange={(e) => setLongitude(e.target.value)}
          />
        </label>
        <button
          type="button"
          onClick={() => {
            if (
              !latitude.trim() ||
              !longitude.trim() ||
              !Number.isFinite(Number(latitude)) ||
              !Number.isFinite(Number(longitude)) ||
              Math.abs(Number(latitude)) > 90 ||
              Math.abs(Number(longitude)) > 180
            ) {
              setError("Укажите широту от −90 до 90 и долготу от −180 до 180.");
              return;
            }
            add(Number(longitude), Number(latitude));
            setLatitude("");
            setLongitude("");
          }}
        >
          Добавить точку
        </button>
      </div>
      {error && (
        <p role="alert" className="form-error">
          {error}
        </p>
      )}
      {pointIndices.map((index, order) => {
        const feature = data.features[index];
        if (feature.geometry.type !== "Point") return null;
        const coordinates = feature.geometry.coordinates;
        const property = (key: string, value: string) =>
          change({
            ...data,
            features: data.features.map((f, i) =>
              i === index
                ? { ...f, properties: { ...f.properties, [key]: value } }
                : f,
            ),
          });
        return (
          <div key={index} className="biography-map-point">
            <label>
              Точка {order + 1}
              <input
                aria-label={`Название точки ${order + 1}`}
                value={String(
                  feature.properties.name || feature.properties.title || "",
                )}
                maxLength={200}
                onChange={(e) => property("name", e.target.value)}
              />
            </label>
            <label>
              Дата
              <input
                aria-label={`Дата точки ${order + 1}`}
                value={String(feature.properties.date || "")}
                maxLength={100}
                placeholder="1943 или 05.1943"
                onChange={(e) => property("date", e.target.value)}
              />
            </label>
            {[1, 0].map((axis) => (
              <label key={axis}>
                {axis ? "Широта" : "Долгота"}
                <input
                  key={`${index}:${coordinates[axis]}`}
                  type="number"
                  step="any"
                  required
                  min={axis ? -90 : -180}
                  max={axis ? 90 : 180}
                  aria-label={`${axis ? "Широта" : "Долгота"} точки ${order + 1}`}
                  defaultValue={coordinates[axis]}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") {
                      e.preventDefault();
                      e.stopPropagation();
                      e.currentTarget.blur();
                    }
                  }}
                  onBlur={(e) => {
                    if (!e.currentTarget.checkValidity()) {
                      e.currentTarget.reportValidity();
                      return;
                    }
                    const next = [...coordinates];
                    next[axis] = Number(e.currentTarget.value);
                    change({
                      ...data,
                      features: data.features.map((f, i) =>
                        i === index
                          ? {
                              ...f,
                              geometry: { type: "Point", coordinates: next },
                            }
                          : f,
                      ),
                    });
                  }}
                />
              </label>
            ))}
            <div className="biography-map-point-actions">
              <button
                type="button"
                aria-label={`Поднять точку ${order + 1}`}
                disabled={order === 0}
                onClick={() => move(index, -1)}
              >
                <ArrowUp size={16} />
              </button>
              <button
                type="button"
                aria-label={`Опустить точку ${order + 1}`}
                disabled={order === pointIndices.length - 1}
                onClick={() => move(index, 1)}
              >
                <ArrowDown size={16} />
              </button>
              <button
                type="button"
                aria-label={`Удалить точку ${order + 1}`}
                onClick={() =>
                  change({
                    ...data,
                    features: data.features.filter((_, i) => i !== index),
                  })
                }
              >
                <Trash2 size={16} />
              </button>
            </div>
          </div>
        );
      })}
    </PersonDetailDialog>
  );
}
