import { useEffect, useState } from "react";
import { EditorDialog } from "./editor-dialog";
export function LoginDialog({ onClose }: { onClose: () => void }) {
  const [enabled, setEnabled] = useState<boolean | null>(null);
  useEffect(() => {
    const controller = new AbortController();
    void fetch("/api/session", { signal: controller.signal })
      .then((r) => r.json())
      .then((s) => setEnabled(s.yandex === true))
      .catch(() => {
        if (!controller.signal.aborted) setEnabled(false);
      });
    return () => controller.abort();
  }, []);
  return (
    <EditorDialog title="Вход в семейный архив" onClose={onClose}>
      <div className="archive-form">
        {enabled ? (
          <a className="yandex-login" href="/auth/yandex">
            <b>Я</b> Войти с Яндекс ID
          </a>
        ) : (
          <p role="status">
            {enabled === null
              ? "Подключаем вход…"
              : "Вход через Яндекс пока недоступен."}
          </p>
        )}
      </div>
    </EditorDialog>
  );
}
