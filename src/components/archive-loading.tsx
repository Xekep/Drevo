export function ArchiveLoading() {
  return (
    <div
      className="archive-status archive-status-loading"
      role="status"
      aria-label="Загрузка архива"
    >
      <span className="archive-loader-ring" aria-hidden="true" />
    </div>
  );
}
