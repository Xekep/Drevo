import { useEffect, useRef, useState } from "react";

export function useListLimit(key = "") {
  const [page, setPage] = useState({ key, count: 30 });
  const limit = page.key === key ? page.count : 30;
  return { limit, more: () => setPage({ key, count: limit + 30 }) };
}

/** Автоподгрузка при прокрутке; кнопка остаётся доступна без IntersectionObserver. */
export function LoadMore({ onMore }: { onMore: () => void }) {
  const button = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (!window.IntersectionObserver || !button.current) return;
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
  }, [onMore]);
  return (
    <button ref={button} className="load-more" onClick={onMore}>
      Показать ещё
    </button>
  );
}
