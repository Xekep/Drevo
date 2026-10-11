import type { BookReaderInstance } from "./bookreader-runtime";

/** Adapter for the pinned BookReader: mixed formats need a new fit and scroll extent. */
export function installBookReaderPageNavigation(reader: BookReaderInstance) {
  const single = reader._modes.mode1Up.mode1UpLit;
  const spread = reader._modes.mode2Up.mode2UpLit;
  let frame = 0;
  let disposed = false;
  const syncSingleExtent = () => {
    const last = single.pages.at(-1);
    if (
      !single.isConnected ||
      !last ||
      !single.clientHeight ||
      !(single.scale > 0)
    )
      return;
    const native = single.computeWorldDimensions();
    const viewport = single.coordSpace.visiblePixelsToWorldUnits(
      single.clientHeight,
    );
    const height =
      native.height +
      Math.max(0, viewport - last.heightInches - single.SPACING_IN);
    if (Math.abs(single.worldDimensions.height - height) > 1e-6) {
      single.worldDimensions = { ...native, height };
      single.requestUpdate();
    }
  };
  const nativeJump = single.jumpToIndex;
  let jumpRequest = 0;
  single.jumpToIndex = (index, options) => {
    const request = ++jumpRequest;
    syncSingleExtent();
    // The new scroll height must exist before the browser clamps scrollTop.
    // This also covers direct links to the last page and returning from 2up.
    void single.updateComplete.then(() => {
      if (!disposed && request === jumpRequest)
        nativeJump.call(single, index, options);
    });
  };
  const update = () => {
    frame = 0;
    if (disposed) return;
    if (reader.mode === reader.constMode2up && spread.isConnected) {
      // The native flip retains the previous spread's scale. Refit after its
      // animation, but preserve an explicit zoom (autoFit === "none").
      if (!spread.activeFlip && spread.autoFit !== "none") {
        spread.resizeViaAutofit();
        spread.recenter();
      }
    } else if (reader.mode === reader.constMode1up && single.isConnected) {
      // Allow the last page to reach the viewport's top. Otherwise the native
      // first-visible-page index gets stuck before a short final page.
      syncSingleExtent();
    }
  };
  const schedule = () => {
    if (!disposed && !frame) frame = requestAnimationFrame(update);
  };
  const events = [
    "pageChanged",
    "1PageViewSelected",
    "2PageViewSelected",
    "resize",
  ];
  events.forEach((event) => reader.bind(event, schedule));
  const resize = new ResizeObserver(schedule);
  resize.observe(single);
  // A zoom changes the world's transform, not its ResizeObserver box. Initial
  // child insertion also covers a 1up view which has never been mounted yet.
  const mutation = new MutationObserver((records) => {
    if (
      records.some(
        (record) =>
          record.type === "childList" ||
          (record.target instanceof Element &&
            record.target.classList.contains("br-mode-1up__world")),
      )
    )
      schedule();
  });
  mutation.observe(single, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: ["style"],
  });
  const keepManualZoom = (event: MouseEvent) => {
    if (
      reader.mode === reader.constMode2up &&
      event.target instanceof Element &&
      event.target.closest(".zoom_in,.zoom_out")
    )
      spread.autoFit = "none";
  };
  document.addEventListener("click", keepManualZoom, true);
  schedule();
  return () => {
    disposed = true;
    single.jumpToIndex = nativeJump;
    cancelAnimationFrame(frame);
    resize.disconnect();
    mutation.disconnect();
    events.forEach((event) => reader.unbind(event, schedule));
    document.removeEventListener("click", keepManualZoom, true);
  };
}
