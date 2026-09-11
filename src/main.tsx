import { StrictMode, lazy, Suspense } from "react";
import { createRoot } from "react-dom/client";
import "@xyflow/react/dist/style.css";
import "./styles/app.css";
import "./styles/workspace.css";
import "./styles/polish.css";
import "./styles/tree-workspace.css";
import "./styles/timeline.css";
import "./styles/directory.css";
import "./styles/places.css";
import "./styles/family-details.css";
import "./styles/photo-workspace.css";
import "./styles/archive-tools.css";
import "./styles/photo-lightbox.css";
import "./styles/insights.css";
import "./styles/mobile-refinements.css";

const App = lazy(() => import("./App"));
const SharedTree = lazy(() => import("./components/shared-tree"));
const sharedToken = /^\/s\/([A-Za-z0-9_-]{43})$/.exec(location.pathname)?.[1];

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <Suspense
      fallback={
        <main className="archive-status" role="status">
          <p>Открываем семейный архив…</p>
        </main>
      }
    >
      {sharedToken ? <SharedTree token={sharedToken} /> : <App />}
    </Suspense>
  </StrictMode>,
);
