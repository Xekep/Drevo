import { memo, useMemo } from "react";
import { renderCommentHtml } from "./markdown-format";
import "katex/dist/katex.min.css";

export const CommentMarkdown = memo(function CommentMarkdown({
  text,
}: {
  text: string;
}) {
  const html = useMemo(() => renderCommentHtml(text), [text]);
  return (
    <div
      className="comment-markdown"
      dangerouslySetInnerHTML={{ __html: html }}
    />
  );
});
