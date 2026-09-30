import { useState } from "react";
import { Check, Link2 } from "lucide-react";
import { archiveTargetPath, type ArchiveTarget } from "../domain/archive-links";
import { scopedArchivePath } from "../domain/archive-context.ts";

export function CopyArchiveLink({
  target,
  className,
}: {
  target: ArchiveTarget;
  className?: string;
}) {
  const [status, setStatus] = useState<"idle" | "copied" | "error">("idle");
  const label =
    status === "copied"
      ? "Ссылка скопирована"
      : status === "error"
        ? "Не удалось скопировать ссылку"
        : "Скопировать ссылку";
  return (
    <button
      type="button"
      className={className}
      title={label}
      aria-label={label}
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(
            new URL(scopedArchivePath(archiveTargetPath(target)), window.location.origin).href,
          );
          setStatus("copied");
        } catch {
          setStatus("error");
        }
      }}
    >
      {status === "copied" ? <Check size={18} /> : <Link2 size={18} />}
      <span className="archive-copy-status" role="status">
        {status === "idle" ? "" : label}
      </span>
    </button>
  );
}
