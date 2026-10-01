import { memo, useEffect, useMemo, useRef } from "react";
import { renderCommentHtml } from "./markdown-format";
import { enhanceCommentDiagrams } from "./mermaid-preview";
import "katex/dist/katex.min.css";

export const CommentMarkdown = memo(function CommentMarkdown({
  text,
}: {
  text: string;
}) {
  const html = useMemo(() => renderCommentHtml(text), [text]);
  const host = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (host.current) return enhanceCommentDiagrams(host.current);
  }, [html]);
  return (
    <div
      className="comment-markdown"
      ref={host}
      dangerouslySetInnerHTML={{ __html: html }}
    />
  );
});
