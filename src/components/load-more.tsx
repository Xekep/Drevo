import { useEffect, useRef, useState } from "react";

export function useListLimit(key = "") {
  const [page, setPage] = useState({ key, count: 30 });
  const limit = page.key === key ? page.count : 30;
  return { limit, more: () => setPage({ key, count: limit + 30 }) };
}

/** Автоподгрузка при прокрутке; кнопка остаётся доступна без IntersectionObserver. */
export function LoadMore({ onMore, busy = false, automatic = true, label = "Показать ещё", className = "" }: {
  onMore: () => void; busy?: boolean; automatic?: boolean; label?: string; className?: string;
}) {
  const button = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (busy || !automatic || !window.IntersectionObserver || !button.current) return;
    const observer = new IntersectionObserver(
      ([entry]) => {
        if (entry.isIntersecting) {
          observer.disconnect();
          onMore();
        }
      },
      { rootMargin: "120px" },
    );
    observer.observe(button.current);
    return () => observer.disconnect();
  }, [onMore, busy, automatic]);
  return (
    <button ref={button} className={`load-more ${className}`} onClick={onMore} disabled={busy}>
      {busy ? "Загружается…" : label}
    </button>
  );
}
