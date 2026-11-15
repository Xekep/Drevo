import { unified } from "unified";
import remarkParse from "remark-parse";
import remarkGfm from "remark-gfm";
import type { Nodes } from "mdast";

const parser = unified().use(remarkParse).use(remarkGfm);

/** Preview prose only: embedded GeoJSON, URLs and Markdown syntax are not an excerpt. */
export function biographySummary(source: string): string | null {
  if (source.length <= 600) return null;
  const prose = (node: Nodes): string => {
    if (node.type === "text" || node.type === "inlineCode") return node.value;
    if (node.type === "code" || node.type === "html" || node.type === "definition") return "";
    if (node.type === "break") return " ";
    if (!("children" in node)) return "";
    return node.children.map(prose).join(["root", "list", "listItem", "blockquote", "table", "tableRow"].includes(node.type) ? " " : "");
  };
  const text = prose(parser.parse(source)).replace(/\s+/g, " ").trim();
  const characters = Array.from(text);
  if (characters.length <= 600) return null;
  const prefix = characters.slice(0, 280).join("");
  const boundary = prefix.lastIndexOf(" ");
  return `${boundary > 200 ? prefix.slice(0, boundary) : prefix}…`;
}
