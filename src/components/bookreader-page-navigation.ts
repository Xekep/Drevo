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
  // The native 1up view scrolls vertically but has no horizontal page gesture.
  // Leave vertical scrolling and two-finger zoom with the browser.
  let swipe: { x: number; y: number; time: number; page: number } | null = null;
  const touchStart = (event: TouchEvent) => {
    swipe = null;
    if (
      event.touches.length !== 1 ||
      reader.mode !== reader.constMode1up ||
      document.body.matches(".drevo-annotating, .drevo-magnifying") ||
      !(event.target instanceof Element) ||
      event.target.closest("button, a, input, textarea, select") ||
      single.scrollWidth > single.clientWidth + 2
    ) return;
    const touch = event.touches[0];
    swipe = { x: touch.clientX, y: touch.clientY, time: performance.now(), page: reader.currentIndex() };
  };
  const cancelSwipe = () => { swipe = null; };
  const touchMove = (event: TouchEvent) => {
    if (!swipe) return;
    const touch = event.touches[0];
    if (event.touches.length !== 1 || Math.abs(touch.clientY - swipe.y) > Math.max(10, Math.abs(touch.clientX - swipe.x)))
      cancelSwipe();
    else if (Math.abs(touch.clientX - swipe.x) > 10 && event.cancelable)
      // In particular, a right swipe on the first page must not navigate the
      // browser back out of the document.
      event.preventDefault();
  };
  const touchEnd = (event: TouchEvent) => {
    const start = swipe;
    swipe = null;
    if (!start || event.touches.length || !event.changedTouches.length) return;
    const touch = event.changedTouches[0];
    const dx = touch.clientX - start.x;
    const dy = touch.clientY - start.y;
    if (
      reader.mode !== reader.constMode1up ||
      start.page !== reader.currentIndex() ||
      document.body.matches(".drevo-annotating, .drevo-magnifying") ||
      Math.abs(dx) < Math.min(90, single.clientWidth * 0.22) ||
      Math.abs(dx) <= Math.abs(dy) * 1.5 ||
      performance.now() - start.time > 1200
    ) return;
    const page = Math.max(0, Math.min(single.pages.length - 1, start.page + (dx < 0 ? 1 : -1)));
    if (page !== start.page) reader.jumpToIndex(page);
  };
  single.addEventListener("touchstart", touchStart, { passive: true });
  single.addEventListener("touchmove", touchMove, { passive: false });
  single.addEventListener("touchend", touchEnd, { passive: true });
  single.addEventListener("touchcancel", cancelSwipe);
  schedule();
  return () => {
    disposed = true;
    single.jumpToIndex = nativeJump;
    cancelAnimationFrame(frame);
    resize.disconnect();
    mutation.disconnect();
    events.forEach((event) => reader.unbind(event, schedule));
    document.removeEventListener("click", keepManualZoom, true);
    single.removeEventListener("touchstart", touchStart);
    single.removeEventListener("touchmove", touchMove);
    single.removeEventListener("touchend", touchEnd);
    single.removeEventListener("touchcancel", cancelSwipe);
  };
}
