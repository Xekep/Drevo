import { useEffect, useEffectEvent } from "react";
import { X } from "lucide-react";

const HIDE_AFTER_MS = 5000;

/** Notification lifetime follows the message, not unrelated app renders. */
export function ArchiveToast({ message, onClose }: { message: string; onClose: () => void }) {
  const dismiss = useEffectEvent(onClose);
  useEffect(() => {
    const timer = setTimeout(() => dismiss(), HIDE_AFTER_MS);
    return () => clearTimeout(timer);
  }, [message]);
  return <div className="archive-toast" role="status">
    {message}
    <button type="button" onClick={onClose} aria-label="Закрыть уведомление">
      <X size={17} aria-hidden="true" />
    </button>
  </div>;
}
