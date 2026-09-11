import { lazy, Suspense } from "react";
import type { Family } from "../domain";
import { LazyChunkBoundary } from "./lazy-chunk-boundary";
import { loadLazyModule } from "./lazy-section-recovery";

type AdminPanelProps = {
  family: Family;
  onClose: () => void;
  onChanged: () => void;
  onSettings: () => void;
};

const AdminPanelContent = lazy(() =>
  loadLazyModule(
    () =>
      import("./admin-panel-content").then((module) => ({
        default: module.AdminPanel,
      })),
    "admin-panel",
  ),
);

export function AdminPanel(props: AdminPanelProps) {
  return (
    <LazyChunkBoundary message="Управление архивом не загрузилось. Обновите страницу и повторите вход в админку.">
      <Suspense
        fallback={
          <main className="admin-page">
            <div className="archive-status" role="status">
              Открываем управление архивом…
            </div>
          </main>
        }
      >
        <AdminPanelContent {...props} />
      </Suspense>
    </LazyChunkBoundary>
  );
}
