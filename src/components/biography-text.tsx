import { lazy, Suspense, useCallback, useId, useMemo, useRef, useState } from "react";
import { MarkdownText } from "./markdown-text";
import { EditorDialog } from "./editor-dialog";
import { parseBiographyMap } from "../domain/biography-map";
import { biographySummary } from "../domain/biography-summary";
const MapWorkspace = lazy(() => import("./biography-map-workspace"));

export function BiographyText({
  text,
  onOpenMap,
}: {
  text: string;
  onOpenMap?: (source: string) => void;
}) {
  const summary = useMemo(() => biographySummary(text), [text]);
  const [expandedText, setExpandedText] = useState<string | null>(null);
  const expanded = !summary || expandedText === text;
  const contentId = useId();
  const toggle = useRef<HTMLButtonElement>(null);
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
      {!expanded && <div className="person-biography-text"><p>{summary}</p></div>}
      <div id={contentId} hidden={!expanded}>
      {expanded && <MarkdownText
        text={text}
        className="person-biography-text"
        onOpenMap={open}
      />}
      </div>
      {summary && <button type="button" ref={toggle} className="text-button biography-toggle"
        aria-expanded={expanded} aria-controls={contentId}
        onClick={() => {
          setExpandedText(expanded ? null : text);
          if (expanded) toggle.current?.scrollIntoView({ block: "nearest", behavior: "instant" });
        }}>{expanded ? "Свернуть" : "Читать далее"}</button>}
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
