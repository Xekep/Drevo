import LazyCommentEditor from "./discussion/lazy-comment-editor";
import "../styles/person-discussion.css";
import "../styles/biography-map.css";

export function BiographyEditor({
  value,
  onChange,
}: {
  value: string;
  onChange: (text: string) => void;
}) {
  return (
    <LazyCommentEditor
      value={value}
      onChange={onChange}
      label="История человека"
      onSubmit={() => {}}
      biography
      loadOnMount
      className="biography-editor"
      placeholder="История человека…"
    />
  );
}
