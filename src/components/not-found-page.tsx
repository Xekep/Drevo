import { useEffect } from "react";
import { notFoundContent, notFoundStyles } from "../shared/not-found-page.ts";

export function NotFoundPage() {
  useEffect(() => {
    document.title = "Страница не найдена · Drevo";
  }, []);
  return (
    <>
      <style>{notFoundStyles}</style>
      <main
        className="lost-page"
        dangerouslySetInnerHTML={{ __html: notFoundContent }}
      />
    </>
  );
}
