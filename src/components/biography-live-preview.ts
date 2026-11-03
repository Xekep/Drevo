import { StateField, type EditorState, type Range } from "@codemirror/state";
import {
  Decoration,
  EditorView,
  WidgetType,
  type DecorationSet,
} from "@codemirror/view";
import type { Nodes } from "mdast";
import { parseCommentDocument } from "./discussion/markdown-format";
import { PreviewWidget, previewFocus } from "./discussion/live-preview";
import { parseBiographyMap } from "../domain/biography-map";

class MapWidget extends WidgetType {
  constructor(
    readonly source: string,
    readonly from: number,
    readonly to: number,
    readonly title: string,
  ) {
    super();
  }
  eq(other: MapWidget) {
    return (
      other.source === this.source &&
      other.from === this.from &&
      other.to === this.to &&
      other.title === this.title
    );
  }
  toDOM(view: EditorView) {
    const host = document.createElement("div"),
      button = document.createElement("button");
    host.className = "biography-map-fold";
    button.type = "button";
    button.className = "biography-map-source";
    button.setAttribute("aria-label", `Показать GeoJSON: ${this.title}`);
    button.title = `${this.title} · Показать GeoJSON`;
    const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    svg.setAttribute("viewBox", "0 0 24 24");
    svg.setAttribute("width", "22");
    svg.setAttribute("height", "22");
    svg.setAttribute("fill", "none");
    svg.setAttribute("stroke", "currentColor");
    svg.setAttribute("stroke-width", "1.8");
    svg.setAttribute("aria-hidden", "true");
    const path = document.createElementNS(svg.namespaceURI, "path");
    path.setAttribute(
      "d",
      "m3 6 6-3 6 3 6-3v15l-6 3-6-3-6 3V6Zm6-3v15m6-12v15",
    );
    svg.append(path);
    button.append(svg);
    host.append(button);
    button.onclick = (event) => {
      event.preventDefault();
      event.stopPropagation();
      view.dispatch({
        selection: { anchor: Math.min(view.state.doc.length, this.from + 4) },
        scrollIntoView: true,
      });
      view.focus();
    };
    return host;
  }
  ignoreEvent() {
    return true;
  }
}

class BulletWidget extends WidgetType {
  constructor(readonly value: string) {
    super();
  }
  eq(other: BulletWidget) {
    return other.value === this.value;
  }
  toDOM() {
    const span = document.createElement("span");
    span.textContent = this.value;
    return span;
  }
  ignoreEvent() {
    return false;
  }
}

/** Inline decorations keep native caret placement, wrapping and selection.
 * Every selected line exposes all its Markdown delimiters. Structural blocks
 * (tables, formulas, maps and fenced code) expose their complete source. */
export function biographyLivePreview() {
  function decorations(state: EditorState, focused: boolean): DecorationSet {
    const source = state.doc.toString(),
      tree = parseCommentDocument(source);
    const ranges: Range<Decoration>[] = [],
      styledLines = new Set<string>();
    const selected = focused
      ? state.selection.ranges.map((r) => ({
          from: state.doc.lineAt(r.from).from,
          to: state.doc.lineAt(r.to).to,
        }))
      : [];
    const editing = (from: number, to: number) =>
      selected.some((r) => from <= r.to && to >= r.from);
    const hide = (from: number, to: number) => {
      if (to > from && !editing(from, to))
        ranges.push(Decoration.replace({}).range(from, to));
    };
    const lineStyle = (from: number, name: string) => {
      const line = state.doc.lineAt(from),
        key = `${line.number}:${name}`;
      if (!editing(line.from, line.to) && !styledLines.has(key)) {
        styledLines.add(key);
        ranges.push(Decoration.line({ class: name }).range(line.from));
      }
    };
    function visit(node: Nodes) {
      const from = node.position?.start.offset,
        to = node.position?.end.offset;
      if (from == null || to == null || from === to) return;
      if (["code", "table", "math", "thematicBreak"].includes(node.type)) {
        let mapTitle: string | undefined;
        if (node.type === "code" && node.lang?.toLowerCase() === "geojson") {
          try {
            mapTitle = parseBiographyMap(node.value).name || "Карта жизни";
          } catch {
            return;
          }
        }
        if (!editing(from, to))
          ranges.push(
            Decoration.replace({
              block: true,
              widget:
                mapTitle && node.type === "code"
                  ? new MapWidget(node.value, from, to, mapTitle)
                  : new PreviewWidget(source.slice(from, to), from),
            }).range(from, to),
          );
        return;
      }
      if (["inlineMath", "image"].includes(node.type) && !editing(from, to)) {
        ranges.push(
          Decoration.replace({
            widget:
              node.type === "inlineMath"
                ? new PreviewWidget(node.value, from, true)
                : new PreviewWidget(source.slice(from, to), from),
          }).range(from, to),
        );
        return;
      }
      if (
        ["strong", "emphasis", "delete", "link"].includes(node.type) &&
        "children" in node
      ) {
        const start = node.children[0]?.position?.start.offset,
          end = node.children.at(-1)?.position?.end.offset;
        if (start != null && end != null) {
          hide(from, start);
          hide(end, to);
          if (node.type === "link" && end > start)
            ranges.push(
              Decoration.mark({ class: "biography-link" }).range(start, end),
            );
        }
      }
      if (node.type === "inlineCode") {
        const marks = source.slice(from, to).match(/^`+/)?.[0].length || 1;
        hide(from, from + marks);
        hide(to - marks, to);
        ranges.push(
          Decoration.mark({ class: "biography-code" }).range(from, to),
        );
      }
      if (node.type === "heading") {
        lineStyle(from, "biography-heading");
        const prefix = source.slice(from, to).match(/^#{1,6}\s+/)?.[0];
        if (prefix) hide(from, from + prefix.length);
      }
      if (node.type === "blockquote") {
        for (
          let n = state.doc.lineAt(from).number;
          n <= state.doc.lineAt(to).number;
          n++
        ) {
          const line = state.doc.line(n),
            prefix = line.text.match(/^\s*>\s?/);
          lineStyle(line.from, "biography-quote");
          if (prefix) hide(line.from, line.from + prefix[0].length);
        }
      }
      if (
        node.type === "listItem" &&
        !editing(from, state.doc.lineAt(from).to)
      ) {
        const prefix = source
          .slice(from, to)
          .match(/^(?:[-+*]|\d+[.)])\s+(?:\[[ xX]\]\s+)?/);
        if (prefix) {
          const bullet =
            node.checked === true
              ? "☑ "
              : node.checked === false
                ? "☐ "
                : /^\d/.test(prefix[0])
                  ? prefix[0]
                  : "• ";
          ranges.push(
            Decoration.replace({ widget: new BulletWidget(bullet) }).range(
              from,
              from + prefix[0].length,
            ),
          );
        }
      }
      if ("children" in node) node.children.forEach(visit);
    }
    tree.children.forEach(visit);
    return Decoration.set(ranges, true);
  }
  return StateField.define<{ focused: boolean; decorations: DecorationSet }>({
    create: (state) => ({
      focused: false,
      decorations: decorations(state, false),
    }),
    update(value, transaction) {
      let focused = value.focused;
      for (const effect of transaction.effects)
        if (effect.is(previewFocus)) focused = effect.value;
      if (
        !transaction.docChanged &&
        !transaction.selection &&
        focused === value.focused
      )
        return value;
      return { focused, decorations: decorations(transaction.state, focused) };
    },
    provide: (field) =>
      EditorView.decorations.from(field, (value) => value.decorations),
  });
}

/** Wrap a pasted GeoJSON object, preserving every property and its formatting.
 * Pasting inside existing code remains an ordinary text replacement. */
export function pasteBiographyMap(event: ClipboardEvent, view: EditorView) {
  if (view.state.readOnly) return false;
  const source = event.clipboardData?.getData("text/plain").trim();
  if (!source?.startsWith("{")) return false;
  try {
    parseBiographyMap(source);
  } catch {
    return false;
  }
  const range = view.state.selection.main;
  const insideCode = (node: Nodes): boolean =>
    (node.type === "code" &&
      node.position?.start.offset != null &&
      node.position.end.offset != null &&
      node.position.start.offset <= range.from &&
      node.position.end.offset >= range.to) ||
    ("children" in node && node.children.some(insideCode));
  if (insideCode(parseCommentDocument(view.state.doc.toString()))) return false;
  const insert = `${range.from ? "\n\n" : ""}\`\`\`geojson\n${source}\n\`\`\`\n\n`;
  event.preventDefault();
  view.dispatch({
    changes: { from: range.from, to: range.to, insert },
    selection: { anchor: range.from + insert.length },
    scrollIntoView: true,
    userEvent: "input.paste",
  });
  return true;
}
