import { MarkdownText } from "./markdown-text";

export function DocumentCommentText({ text }: { text: string }) {
  return <MarkdownText text={text} className="pdf-book-comment-text" />;
}
