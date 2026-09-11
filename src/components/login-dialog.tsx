import { useEffect, useRef } from "react";

export function LoginDialog({ onClose }: { onClose: () => void }) {
  const close = useRef(onClose);

  useEffect(() => {
    try {
      window.location.assign("/auth/yandex");
    } catch {
      close.current();
    }
  }, []);

  return null;
}
