import {
  Component,
  StrictMode,
  lazy,
  Suspense,
  useEffect,
  useState,
  type ReactNode,
} from "react";
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
import "./styles/award-loading.css";
import "./styles/photo-workspace.css";
import "./styles/archive-tools.css";
import "./styles/photo-lightbox.css";
import "./styles/insights.css";
import "./styles/mobile-refinements.css";
import "./styles/controls.css";
import "./styles/research-assistant.css";
import "./styles/design-refinement.css";
import "./styles/entry-sequence.css";
import "./styles/public-people.css";
import { ArchiveLoading } from "./components/archive-loading";
import { memberPreviewAt } from "./domain/archive-context.ts";
import { archiveViewAt } from "./domain/archive-routes.ts";

const App = lazy(() => import("./App"));
const SharedTree = lazy(() => import("./components/shared-tree"));
const PublicPeople = lazy(() => import("./components/public-people"));
const DiscoveryLinkedBranchPerson = lazy(() =>
  import("./components/discovery-linked-branch-person").then((module) => ({
    default: module.DiscoveryLinkedBranchPerson,
  })),
);
const JoinArchive = lazy(() =>
  import("./components/join-archive").then((module) => ({
    default: module.JoinArchive,
  })),
);
const sharedToken =
  /^\/(?:a\/[A-Za-z0-9][A-Za-z0-9-]{2,63}\/)?s\/([A-Za-z0-9_-]{43})$/.exec(
    location.pathname,
  )?.[1];
const join =
  /^\/join\/([A-Za-z0-9][A-Za-z0-9-]{2,63})\/([A-Za-z0-9_-]{43})$/.exec(
    location.pathname,
  );
const linkedBranch = (() => {
  const match = /^\/discover\/linked\/([A-Za-z0-9-]{3,64})\/([a-f0-9-]{36})\/([^/]{1,1200})$/.exec(
    location.pathname,
  );
  if (!match) return null;
  try {
    const personId = decodeURIComponent(match[3]);
    return personId && personId.length <= 100 ? [match[1], match[2], personId] : null;
  } catch { return null; }
})();
const pendingInvite = (() => {
  try {
    const path = sessionStorage.getItem("drevo_pending_invite") || "";
    return /^\/join\/[A-Za-z0-9][A-Za-z0-9-]{2,63}\/[A-Za-z0-9_-]{43}$/.test(
      path,
    )
      ? path
      : "";
  } catch {
    return "";
  }
})();

function Entry() {
  const [ready, setReady] = useState(
    !!join || !!memberPreviewAt(location.pathname) || !pendingInvite || pendingInvite === location.pathname,
  );
  useEffect(() => {
    if (ready) return;
    const controller = new AbortController();
    void fetch("/api/session", { cache: "no-store", signal: controller.signal })
      .then((response) => response.json())
      .then((session) => {
        if (controller.signal.aborted) return;
        if (session.account) {
          sessionStorage.removeItem("drevo_pending_invite");
          location.replace(pendingInvite);
        } else setReady(true);
      })
      .catch(() => {
        if (!controller.signal.aborted) setReady(true);
      });
    return () => controller.abort();
  }, [ready]);
  if (!ready) return <ArchiveLoading />;
  return sharedToken ? (
    <SharedTree token={sharedToken} />
  ) : join ? (
    <JoinArchive archiveId={join[1]} token={join[2]} />
  ) : linkedBranch ? (
    <DiscoveryLinkedBranchPerson archiveId={linkedBranch[0]}
      matchId={linkedBranch[1]} personId={linkedBranch[2]} />
  ) : location.pathname === "/discover" || location.pathname.startsWith("/discover/") ? (
    <PublicPeople />
  ) : (
    <App />
  );
}

class RootErrorBoundary extends Component<
  { children: ReactNode },
  { failed: boolean }
> {
  state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  render() {
    if (this.state.failed)
      return (
        <main className="archive-status" role="alert">
          <h1>Не удалось открыть архив</h1>
          <p>Проверьте соединение и загрузите актуальную версию страницы.</p>
          <button onClick={() => location.reload()}>Повторить</button>
        </main>
      );
    return this.props.children;
  }
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <RootErrorBoundary>
      <Suspense fallback={<ArchiveLoading canvas={!!sharedToken || archiveViewAt(location.pathname) === "tree"} />}>
        <Entry />
      </Suspense>
    </RootErrorBoundary>
  </StrictMode>,
);
