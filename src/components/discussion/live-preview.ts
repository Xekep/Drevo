import {
  StateEffect,
  StateField,
  type EditorState,
  type Range,
} from "@codemirror/state";
import {
  Decoration,
  EditorView,
  WidgetType,
  type DecorationSet,
} from "@codemirror/view";
import katex from "katex";
import type { Nodes } from "mdast";
import {
  commentMathOptions,
  parseCommentDocument,
  renderCommentHtml,
} from "./markdown-format";

export const previewFocus = StateEffect.define<boolean>();
export const previewSource = StateEffect.define<boolean>();

function selectionTouches(
  state: EditorState,
  from: number,
  to: number,
  includeEnd = false,
) {
  return state.selection.ranges.some((range) =>
    range.empty
      ? range.from >= from && (includeEnd ? range.from <= to : range.from < to)
      : range.from < to && range.to > from,
  );
}

class PreviewWidget extends WidgetType {
  constructor(
    readonly source: string,
    readonly from: number,
    readonly math = false,
  ) {
    super();
  }
  eq(other: PreviewWidget) {
    return (
      this.source === other.source &&
      this.from === other.from &&
      this.math === other.math
    );
  }
  toDOM(view: EditorView) {
    const dom = document.createElement(this.math ? "span" : "div");
    dom.className = this.math
      ? "comment-math-preview"
      : "comment-markdown comment-block-preview";
    dom.innerHTML = this.math
      ? katex.renderToString(this.source, commentMathOptions)
      : renderCommentHtml(this.source);
    dom.addEventListener("mousedown", (event) => {
      // A link in the editor must edit its source, rather than navigate away.
      event.preventDefault();
      view.dispatch({ selection: { anchor: this.from + 1 } });
      view.focus();
    });
    dom.addEventListener("click", (event) => event.preventDefault());
    return dom;
  }
  ignoreEvent() {
    return true;
  }
}

function decorations(
  state: EditorState,
  focused: boolean,
  sourceMode: boolean,
): DecorationSet {
  if (sourceMode) return Decoration.none;
  const source = state.doc.toString();
  const tree = parseCommentDocument(source);
  const ranges: Range<Decoration>[] = [];
  function inline(node: Nodes) {
    const from = node.position?.start.offset,
      to = node.position?.end.offset;
    if (from == null || to == null || to <= from) return;
    const editing = focused && selectionTouches(state, from, to);
    if (node.type === "inlineMath" && !editing) {
      ranges.push(
        Decoration.replace({
          widget: new PreviewWidget(node.value, from, true),
        }).range(from, to),
      );
      return;
    }
    if (
      ["strong", "emphasis", "delete", "link"].includes(node.type) &&
      "children" in node &&
      !editing
    ) {
      const start = node.children[0]?.position?.start.offset;
      const end = node.children.at(-1)?.position?.end.offset;
      if (start != null && start > from)
        ranges.push(Decoration.replace({}).range(from, start));
      if (end != null && end < to)
        ranges.push(Decoration.replace({}).range(end, to));
    }
    if ("children" in node) for (const child of node.children) inline(child);
  }
  for (const node of tree.children) {
    const from = node.position?.start.offset,
      to = node.position?.end.offset;
    if (from == null || to == null || to <= from) continue;
    if (!focused || !selectionTouches(state, from, to, true)) {
      ranges.push(
        Decoration.replace({
          block: true,
          widget: new PreviewWidget(source.slice(from, to), from),
        }).range(from, to),
      );
    } else inline(node);
  }
  return Decoration.set(ranges, true);
}

export const livePreview = StateField.define<{
  focused: boolean;
  source: boolean;
  decorations: DecorationSet;
}>({
  create: (state) => ({
    focused: false,
    source: false,
    decorations: decorations(state, false, false),
  }),
  update(value, transaction) {
    let focused = value.focused,
      source = value.source;
    for (const effect of transaction.effects) {
      if (effect.is(previewFocus)) focused = effect.value;
      if (effect.is(previewSource)) source = effect.value;
    }
    if (
      !transaction.docChanged &&
      !transaction.selection &&
      focused === value.focused &&
      source === value.source
    )
      return value;
    return {
      focused,
      source,
      decorations: decorations(transaction.state, focused, source),
    };
  },
  provide: (field) =>
    EditorView.decorations.from(field, (value) => value.decorations),
});
