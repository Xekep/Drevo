import { useEffect, useState } from "react";
import { Check, Copy } from "lucide-react";

/** Clipboard feedback belongs to one message and never includes adjacent UI. */
export function CopyMessageButton({ text }: { text: string }) {
  const [result, setResult] = useState<{
    text: string;
    status: "idle" | "copied" | "error";
  }>({ text: "", status: "idle" });
  const status = result.text === text ? result.status : "idle";
  useEffect(() => {
    if (result.status === "idle") return;
    const timer = setTimeout(
      () => setResult({ text: "", status: "idle" }),
      2000,
    );
    return () => clearTimeout(timer);
  }, [result]);
  const label = status === "copied" ? "Скопировано" : "Скопировать сообщение";
  return (
    <div className="research-message-actions">
      <button
        type="button"
        className="research-message-copy"
        title={label}
        aria-label={label}
        onClick={async () => {
          try {
            await navigator.clipboard.writeText(text);
            setResult({ text, status: "copied" });
          } catch {
            setResult({ text, status: "error" });
          }
        }}
      >
        {status === "copied" ? (
          <Check size={16} aria-hidden="true" />
        ) : (
          <Copy size={16} aria-hidden="true" />
        )}
      </button>
      <span
        role="status"
        className={
          status === "error" ? "research-message-copy-error" : "sr-only"
        }
      >
        {status === "copied"
          ? "Сообщение скопировано"
          : status === "error"
            ? "Не удалось скопировать сообщение. Попробуйте ещё раз."
            : ""}
      </span>
    </div>
  );
}
