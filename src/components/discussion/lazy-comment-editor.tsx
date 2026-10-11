import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type ComponentProps,
} from "react";
import { loadLazyModule } from "../lazy-section-recovery";
import type Editor from "./comment-editor";
import { GitBranch } from "lucide-react";
import { commentDiagramTemplate } from "./diagram-template";

/** Reading a discussion never downloads CodeMirror; composition loads it on focus. */
export default function LazyCommentEditor(
  props: ComponentProps<typeof Editor>,
) {
  const [loaded, setEditor] = useState<{
    component: typeof Editor;
    focus: boolean;
    selection?: { anchor: number; head: number };
  } | null>(null);
  const [error, setError] = useState("");
  const input = useRef<HTMLTextAreaElement>(null);
  const insertedSelection = useRef<{ anchor: number; head: number } | null>(
    null,
  );
  const pending = useRef(false),
    mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const load = useCallback(async () => {
    if (pending.current) return;
    pending.current = true;
    try {
      const module = await loadLazyModule(
        () => import("./comment-editor"),
        "comment-editor",
      );
      if (mounted.current) {
        const node = input.current;
        setEditor({
          component: module.default,
          focus: !!node && node === document.activeElement,
          ...(insertedSelection.current
            ? { selection: insertedSelection.current }
            : node
              ? {
                  selection: {
                    anchor:
                      node.selectionDirection === "backward"
                        ? node.selectionEnd
                        : node.selectionStart,
                    head:
                      node.selectionDirection === "backward"
                        ? node.selectionStart
                        : node.selectionEnd,
                  },
                }
              : {}),
        });
        setError("");
      }
    } catch {
      if (mounted.current)
        setError(
          "Не удалось загрузить редактор. Можно продолжить в обычном поле.",
        );
    } finally {
      pending.current = false;
    }
  }, []);
  useEffect(() => {
    if (props.focusOnMount) {
      input.current?.focus();
      void load();
    }
  }, [props.focusOnMount, load]);
  if (loaded) {
    const LoadedEditor = loaded.component;
    return (
      <LoadedEditor
        {...props}
        focusOnMount={loaded.focus || props.focusOnMount}
        selectionOnMount={loaded.selection}
      />
    );
  }
  return (
    <div className="comment-editor comment-editor-placeholder">
      <button
        type="button"
        className="comment-insert-diagram"
        disabled={props.disabled}
        aria-label="Добавить схему Mermaid"
        onClick={() => {
          const node = input.current,
            from = node?.selectionStart || 0,
            to = node?.selectionEnd || 0;
          const position = from + commentDiagramTemplate.length;
          insertedSelection.current = { anchor: position, head: position };
          props.onChange(
            props.value.slice(0, from) +
              commentDiagramTemplate +
              props.value.slice(to),
          );
          node?.focus();
          void load();
        }}
      >
        <GitBranch size={15} aria-hidden="true" />
      </button>
      <textarea
        ref={input}
        aria-label={props.label}
        value={props.value}
        disabled={props.disabled}
        placeholder="Напишите вопрос или воспоминание…"
        onFocus={() => void load()}
        onChange={(event) => { insertedSelection.current = null; props.onChange(event.target.value); }}
        onKeyDown={(event) => {
          if (
            (event.ctrlKey || event.metaKey) &&
            event.key === "Enter" &&
            !props.disabled
          ) {
            event.preventDefault();
            props.onSubmit();
          }
        }}
      />
      {error && (
        <p role="status">
          {error}{" "}
          <button type="button" onClick={() => void load()}>
            Повторить
          </button>
        </p>
      )}
    </div>
  );
}
