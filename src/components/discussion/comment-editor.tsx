import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { Compartment, EditorState } from "@codemirror/state";
import { EditorView, keymap, placeholder } from "@codemirror/view";
import { defaultKeymap, history, historyKeymap } from "@codemirror/commands";
import { markdown, markdownLanguage } from "@codemirror/lang-markdown";
import {
  defaultHighlightStyle,
  syntaxHighlighting,
} from "@codemirror/language";
import { livePreview, previewFocus, previewSource } from "./live-preview";
import "katex/dist/katex.min.css";

type Props = {
  value: string;
  onChange: (value: string) => void;
  onSubmit: () => void;
  disabled?: boolean;
  label: string;
  focusOnMount?: boolean;
};

export default function CommentEditor(props: Props) {
  const host = useRef<HTMLDivElement>(null);
  const view = useRef<EditorView | null>(null);
  const callbacks = useRef(props);
  const readonly = useRef(new Compartment());
  const [sourceMode, setSourceMode] = useState(false);
  useLayoutEffect(() => {
    callbacks.current = props;
  });
  useLayoutEffect(() => {
    if (!host.current) return;
    const current = callbacks.current;
    const editor = new EditorView({
      parent: host.current,
      state: EditorState.create({
        doc: current.value,
        extensions: [
          markdown({ base: markdownLanguage, completeHTMLTags: false }),
          history(),
          syntaxHighlighting(defaultHighlightStyle),
          livePreview,
          EditorView.lineWrapping,
          readonly.current.of([
            EditorState.readOnly.of(!!current.disabled),
            EditorView.editable.of(!current.disabled),
          ]),
          EditorView.contentAttributes.of({
            "aria-label": current.label,
            "aria-multiline": "true",
            spellcheck: "true",
          }),
          placeholder("Напишите вопрос или воспоминание…"),
          keymap.of([
            {
              key: "Mod-Enter",
              run: () => {
                if (!callbacks.current.disabled) callbacks.current.onSubmit();
                return true;
              },
            },
            ...defaultKeymap,
            ...historyKeymap,
          ]),
          EditorView.updateListener.of((update) => {
            if (update.docChanged)
              callbacks.current.onChange(update.state.doc.toString());
          }),
          EditorView.domEventHandlers({
            focus: (_event, editor) => {
              editor.dispatch({ effects: previewFocus.of(true) });
            },
            blur: (_event, editor) => {
              editor.dispatch({ effects: previewFocus.of(false) });
            },
          }),
        ],
      }),
    });
    view.current = editor;
    if (current.focusOnMount) editor.focus();
    return () => {
      view.current = null;
      editor.destroy();
    };
  }, []);
  useEffect(() => {
    const editor = view.current;
    if (editor && editor.state.doc.toString() !== props.value)
      editor.dispatch({
        changes: { from: 0, to: editor.state.doc.length, insert: props.value },
      });
  }, [props.value]);
  useEffect(() => {
    view.current?.dispatch({
      effects: readonly.current.reconfigure([
        EditorState.readOnly.of(!!props.disabled),
        EditorView.editable.of(!props.disabled),
      ]),
    });
  }, [props.disabled]);
  return (
    <div className={`comment-editor${sourceMode ? " is-source" : ""}`}>
      <div className="comment-editor-toolbar">
        <span>Markdown · LaTeX</span>
        <button
          type="button"
          disabled={props.disabled}
          aria-pressed={sourceMode}
          onClick={() => {
            const next = !sourceMode;
            setSourceMode(next);
            view.current?.dispatch({ effects: previewSource.of(next) });
            view.current?.focus();
          }}
        >
          Исходный текст
        </button>
      </div>
      <div ref={host} />
      <small className="comment-editor-hint">
        Формулы: $…$ и $$…$$. Нажмите на текст для правки. Ctrl+Enter —
        сохранить.
      </small>
    </div>
  );
}
