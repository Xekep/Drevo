import { useEffect, useLayoutEffect, useRef } from "react";
import { Compartment, EditorState } from "@codemirror/state";
import { EditorView, keymap, placeholder } from "@codemirror/view";
import { defaultKeymap, history, historyKeymap } from "@codemirror/commands";
import { markdown, markdownLanguage } from "@codemirror/lang-markdown";
import {
  defaultHighlightStyle,
  syntaxHighlighting,
} from "@codemirror/language";
import { livePreview, previewFocus } from "./live-preview";
import "katex/dist/katex.min.css";
import { GitBranch } from "lucide-react";

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
    <div className="comment-editor">
      <button
        type="button"
        className="comment-insert-diagram"
        disabled={props.disabled}
        aria-label="Добавить схему Mermaid"
        onClick={() => {
          const editor = view.current;
          if (!editor) return;
          const template =
            "\n\n```mermaid\ngraph TD\n  A[Родитель] --> B[Ребёнок]\n```\n\n";
          const range = editor.state.selection.main;
          editor.dispatch({
            changes: { from: range.from, to: range.to, insert: template },
            selection: { anchor: range.from + template.length },
          });
          editor.focus();
        }}
      >
        <GitBranch size={15} aria-hidden="true" />
      </button>
      <div ref={host} />
    </div>
  );
}
