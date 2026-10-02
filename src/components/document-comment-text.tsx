import { memo } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

export const DocumentCommentText = memo(function DocumentCommentText({
  text,
}: {
  text: string;
}) {
  return (
    <div className="pdf-book-comment-text">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        skipHtml
        components={{
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
