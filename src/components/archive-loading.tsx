export function ArchiveLoading({ canvas = false }: { canvas?: boolean }) {
  return (
    <div
      className={`archive-status archive-status-loading${canvas ? " is-canvas-loading" : ""}`}
      role="status"
      aria-label="Загрузка архива"
    >
      <span className="archive-loader-ring" aria-hidden="true" />
    </div>
  );
}
