import { memo } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { BiographyMapPreview } from "./biography-map-preview";

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
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        skipHtml
        components={{
          pre: ({ node, children }) => {
            const code = node?.children[0];
            if (
              onOpenMap &&
              code?.type === "element" &&
              code.tagName === "code" &&
              Array.isArray(code.properties.className) &&
              code.properties.className.includes("language-geojson")
            ) {
              const source = code.children
                .map((child) => (child.type === "text" ? child.value : ""))
                .join("")
                .trimEnd();
              return <BiographyMapPreview source={source} onOpen={onOpenMap} />;
            }
            return <pre>{children}</pre>;
          },
          a: ({ children, href }) =>
            href ? (
              <a href={href} target="_blank" rel="noopener noreferrer">
                {children}
              </a>
            ) : (
              <>{children}</>
            ),
        }}
      >
        {text}
      </ReactMarkdown>
    </div>
  );
});
