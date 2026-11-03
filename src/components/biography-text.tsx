import { lazy, Suspense, useCallback, useState } from "react";
import { MarkdownText } from "./markdown-text";
import { EditorDialog } from "./editor-dialog";
import { parseBiographyMap } from "../domain/biography-map";
const MapWorkspace = lazy(() => import("./biography-map-workspace"));

export function BiographyText({
  text,
  onOpenMap,
}: {
  text: string;
  onOpenMap?: (source: string) => void;
}) {
  const [preview, setPreview] = useState<string | null>(null);
  const open = useCallback(
    (source: string) => {
      if (onOpenMap) onOpenMap(source);
      else setPreview(source);
    },
    [onOpenMap],
  );
  const current = preview && text.includes(preview) ? preview : null;
  return (
    <>
      <MarkdownText
        text={text}
        className="person-biography-text"
        onOpenMap={open}
      />
      {current && (
        <EditorDialog
          title="Карта жизни"
          className="biography-map-preview-dialog"
          onClose={() => setPreview(null)}
        >
          <Suspense fallback={<p role="status">Загрузка карты…</p>}>
            <MapWorkspace
              data={parseBiographyMap(current)}
              returnLabel="Вернуться к карточке"
              onClose={() => setPreview(null)}
            />
          </Suspense>
        </EditorDialog>
      )}
    </>
  );
}
