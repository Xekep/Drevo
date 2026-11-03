import { lazy, Suspense, useState } from "react";
import { MapPin } from "lucide-react";
import {
  biographyMapBlock,
  parseBiographyMap,
  type BiographyMap,
} from "../domain/biography-map";
import LazyCommentEditor from "./discussion/lazy-comment-editor";
import { EditorDialog } from "./editor-dialog";
import "../styles/person-discussion.css";
import "../styles/biography-map.css";
const MapEditor = lazy(() => import("./biography-map-editor"));
const MapWorkspace = lazy(() => import("./biography-map-workspace"));

export function BiographyEditor({
  value,
  onChange,
  onDirtyChange,
}: {
  value: string;
  onChange: (text: string) => void;
  onDirtyChange?: (dirty: boolean) => void;
}) {
  const [map, setMap] = useState<{
    data: BiographyMap;
    baseline: string;
    range?: { from: number; to: number };
  } | null>(null);
  const [preview, setPreview] = useState<BiographyMap | null>(null);
  return (
    <>
      <LazyCommentEditor
        value={value}
        onChange={onChange}
        label="История человека"
        onSubmit={() => {}}
        biography
        loadOnMount
        className="biography-editor"
        placeholder="История человека…"
        mapActions={{
          onOpen: (source) => setPreview(parseBiographyMap(source)),
          onEdit: (source, range) =>
            setMap({ data: parseBiographyMap(source), baseline: value, range }),
        }}
        tools={
          <button
            type="button"
            className="biography-add-map"
            onClick={() =>
              setMap({
                data: { type: "FeatureCollection", features: [] },
                baseline: value,
              })
            }
          >
            <MapPin size={15} aria-hidden="true" /> Добавить карту
          </button>
        }
      />
      {map && (
        <Suspense fallback={<p role="status">Загрузка редактора карты…</p>}>
          <MapEditor
            initial={map.data}
            onDirtyChange={onDirtyChange}
            onClose={() => setMap(null)}
            onApply={(data) => {
              if (value !== map.baseline)
                throw new Error(
                  "Биография изменилась, пока была открыта карта. Закройте карту и откройте её снова.",
                );
              const block = biographyMapBlock(data);
              onChange(
                map.range
                  ? value.slice(0, map.range.from) +
                      block +
                      value.slice(map.range.to)
                  : value + (value ? "\n\n" : "") + block,
              );
              setMap(null);
            }}
          />
        </Suspense>
      )}
      {preview && (
        <EditorDialog
          title="Карта жизни"
          className="biography-map-preview-dialog"
          onClose={() => setPreview(null)}
        >
          <Suspense fallback={<p role="status">Загрузка карты…</p>}>
            <MapWorkspace
              data={preview}
              returnLabel="Вернуться к биографии"
              onClose={() => setPreview(null)}
            />
          </Suspense>
        </EditorDialog>
      )}
    </>
  );
}
