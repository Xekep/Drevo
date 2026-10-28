/** A large export may keep making progress beyond 30 seconds. Stop stalled
 * stages, but retain a separate hard bound that progress cannot extend. */
export function treeExportDeadline(
  onTimeout: (reason: "idle" | "total") => void,
  idleMs = 30_000,
  totalMs = 180_000,
) {
  let closed = false;
  let idle: ReturnType<typeof setTimeout>;
  const fail = (reason: "idle" | "total") => {
    if (closed) return;
    dispose();
    onTimeout(reason);
  };
  const total = setTimeout(() => fail("total"), totalMs);
  function dispose() {
    closed = true;
    clearTimeout(idle);
    clearTimeout(total);
  }
  function progress() {
    if (closed) return;
    clearTimeout(idle);
    idle = setTimeout(() => fail("idle"), idleMs);
  }
  progress();
  return { progress, dispose };
}
