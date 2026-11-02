import { useState } from "react";
import { COMMENT_PREVIEW_LENGTH, type PersonComment } from "../../shared/person-discussion";
import { CommentMarkdown } from "./comment-markdown";

/** The list carries a preview; the rest is fetched only when requested. */
export function DiscussionCommentText({ item, loadFull }: {
  item: PersonComment;
  loadFull: (item: PersonComment) => Promise<PersonComment>;
}) {
  const [expanded, setExpanded] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const characters = Array.from(item.text);
  const more = !!item.textTruncated || (!expanded && characters.length > COMMENT_PREVIEW_LENGTH);
  return <div className="person-discussion-text">
    <CommentMarkdown text={more ? characters.slice(0, COMMENT_PREVIEW_LENGTH).join("") : item.text} />
    {more && <button type="button" className="person-discussion-read-more" disabled={busy}
      onClick={() => {
        setBusy(true);
        setError("");
        void loadFull(item).then(() => setExpanded(true)).catch(reason => {
          if (reason?.name !== "AbortError") setError(reason instanceof Error ? reason.message : "Не удалось загрузить сообщение");
        }).finally(() => setBusy(false));
      }}>{busy ? "Загружаем…" : "Читать далее"}</button>}
    {error && <p className="person-discussion-error" role="alert">{error}</p>}
  </div>;
}
