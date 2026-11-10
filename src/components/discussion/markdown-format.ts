import { unified } from "unified";
import remarkParse from "remark-parse";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import remarkRehype from "remark-rehype";
import rehypeSanitize, { defaultSchema } from "rehype-sanitize";
import rehypeKatex from "rehype-katex";
import rehypeStringify from "rehype-stringify";
import type { Element, Root } from "hast";
import { externalLinkAttributes } from "../../shared/external-links.ts";

function commentExternalLinks() {
  return (tree: Root) => {
    const visit = (node: Root | Element) => {
      if (node.type === "element" && node.tagName === "a" &&
        typeof node.properties.href === "string") {
        Object.assign(node.properties, externalLinkAttributes(node.properties.href));
      }
      for (const child of node.children) {
        if (child.type === "element") visit(child);
      }
    };
    visit(tree);
  };
}

export const commentMathOptions = {
  trust: false,
  throwOnError: false,
  maxExpand: 1000,
  maxSize: 20,
};
const parser = unified().use(remarkParse).use(remarkGfm).use(remarkMath);
const renderer = parser()
  .use(remarkRehype)
  .use(rehypeSanitize, {
    ...defaultSchema,
    attributes: {
      ...defaultSchema.attributes,
      code: [
        ...(defaultSchema.attributes?.code ?? []),
        ["className", "math-inline", "math-display", "language-mermaid"],
      ],
    },
  })
  // Sanitize user markup first; KaTeX then creates its own trusted layout DOM.
  .use(rehypeKatex, commentMathOptions)
  .use(commentExternalLinks)
  .use(rehypeStringify);

export function parseCommentDocument(source: string) {
  return parser.parse(source);
}

export function renderCommentHtml(source: string) {
  return String(renderer.processSync(source));
}
