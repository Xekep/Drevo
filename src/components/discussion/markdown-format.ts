import { unified } from "unified";
import remarkParse from "remark-parse";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import remarkRehype from "remark-rehype";
import rehypeSanitize, { defaultSchema } from "rehype-sanitize";
import rehypeKatex from "rehype-katex";
import rehypeStringify from "rehype-stringify";

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
        ["className", "math-inline", "math-display"],
      ],
    },
  })
  // Sanitize user markup first; KaTeX then creates its own trusted layout DOM.
  .use(rehypeKatex, commentMathOptions)
  .use(rehypeStringify);

export function parseCommentDocument(source: string) {
  return parser.parse(source);
}

export function renderCommentHtml(source: string) {
  return String(renderer.processSync(source));
}
