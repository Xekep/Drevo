import { lazy, Suspense } from "react";
import type { Family } from "../domain";

type AdminPanelProps = {
  family: Family;
  onClose: () => void;
  onChanged: () => void;
  onSettings: () => void;
};

const AdminPanelContent = lazy(() =>
  import("./admin-panel-content").then((module) => ({
    default: module.AdminPanel,
  })),
);

export function AdminPanel(props: AdminPanelProps) {
  return (
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
  );
}
