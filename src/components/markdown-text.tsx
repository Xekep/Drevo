import { createContext, memo, useContext } from "react";
import ReactMarkdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import { BiographyMapPreview } from "./biography-map-preview";

const OpenMap = createContext<((source: string) => void) | undefined>(undefined);
// Stable component types keep embedded maps mounted when Markdown re-renders.
const components: Components = {
  pre: function MarkdownBlock({ node, children }) {
    const onOpenMap = useContext(OpenMap);
    const code = node?.children[0];
    if (onOpenMap && code?.type === "element" && code.tagName === "code" &&
      Array.isArray(code.properties.className) && code.properties.className.includes("language-geojson")) {
      const source = code.children.map(child => child.type === "text" ? child.value : "").join("").trimEnd();
      return <BiographyMapPreview source={source} onOpen={onOpenMap} />;
    }
    return <pre>{children}</pre>;
  },
  a: ({ children, href }) => href
    ? <a href={href} target="_blank" rel="noopener noreferrer">{children}</a>
    : <>{children}</>,
};
const remarkPlugins = [remarkGfm];

export const MarkdownText = memo(function MarkdownText({
  text,
  className,
  onOpenMap,
}: {
  text: string;
  className: string;
  onOpenMap?: (source: string) => void;
}) {
  return (
    <div className={className}>
      <OpenMap value={onOpenMap}>
      <ReactMarkdown
        remarkPlugins={remarkPlugins}
        skipHtml
        components={components}
      >
        {text}
      </ReactMarkdown>
      </OpenMap>
    </div>
  );
});
