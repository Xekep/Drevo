import { useEffect } from "react";

export function LoginDialog({ onClose }: { onClose: () => void }) {
  useEffect(() => {
    window.location.assign("/auth/yandex");
  }, []);

  void onClose;
  return null;
}
