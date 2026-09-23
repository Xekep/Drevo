import { useEffect, useRef } from "react";
import { markEntrySequence } from "./entry-sequence";

export function LoginDialog({ onClose }: { onClose: () => void }) {
  const close = useRef(onClose);

  useEffect(() => {
    try {
      markEntrySequence();
      window.location.assign("/auth/yandex");
    } catch {
      close.current();
    }
  }, []);

  return null;
}
