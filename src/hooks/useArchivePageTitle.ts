import { useEffect } from "react";
import type { ArchiveView } from "../domain/archive-routes";

const sectionTitles: Partial<Record<ArchiveView, string>> = {
  tree: "Древо",
  list: "Люди",
  families: "Семьи",
  gallery: "Фотографии",
  documents: "Документы",
  places: "Места",
  insights: "Сводка",
  resources: "Ресурсы поиска",
  quality: "Проверка данных",
};

/** Management/account pages own their titles; archive names come from permitted data. */
export function useArchivePageTitle(
  view: ArchiveView,
  path: string,
  archiveTitle?: string,
  entityTitle?: string,
) {
  useEffect(() => {
    const section = sectionTitles[view];
    if (!section) return;
    document.title = [...new Set([
      entityTitle || section, archiveTitle, "Семейный архив",
    ].filter(Boolean))].join(" · ");
  }, [view, path, archiveTitle, entityTitle]);
}
