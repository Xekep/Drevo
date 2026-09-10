import test from "node:test";
import assert from "node:assert/strict";
import { bindDockContentSwipe } from "../src/components/dock-content-swipe.ts";

test("content swipe respects nested scrolling, cancels pinch and prevents accidental link clicks", (t) => {
  class ElementStub extends EventTarget {
    parentElement: ElementStub | null = null;
    scrollTop = 0;
    blocked = false;
    classes = new Set<string>();
    properties = new Map<string, string>();
    classList = {
      add: (name: string) => this.classes.add(name),
      remove: (name: string) => this.classes.delete(name),
    };
    style = {
      setProperty: (name: string, value: string) =>
        this.properties.set(name, value),
      removeProperty: (name: string) => this.properties.delete(name),
    };
    closest(): ElementStub | null {
      return this.blocked ? this : this.parentElement?.closest() || null;
    }
    contains(target: ElementStub) {
      for (
        let node: ElementStub | null = target;
        node;
        node = node.parentElement
      )
        if (node === this) return true;
      return false;
    }
  }
  let mobile = true;
  const windowStub = Object.assign(new EventTarget(), {
    getSelection: () => null,
  });
  const globals: Record<string, unknown> = {
    Element: ElementStub,
    window: windowStub,
    matchMedia: () => ({ matches: mobile }),
  };
  const descriptors = Object.keys(globals).map(
    (key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)] as const,
  );
  for (const [key, value] of Object.entries(globals))
    Object.defineProperty(globalThis, key, { value, configurable: true });
  let release = () => {};
  t.after(() => {
    release();
    for (const [key, descriptor] of descriptors) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  });
  const panel = new ElementStub(),
    heading = new ElementStub(),
    content = new ElementStub(),
    name = new ElementStub();
  heading.parentElement = panel;
  content.parentElement = panel;
  name.parentElement = content;
  let closed = 0;
  const cleanup = bindDockContentSwipe(
    panel as unknown as HTMLElement,
    heading as unknown as HTMLElement,
    true,
    () => {
      closed++;
    },
    () => {},
  );
  release = cleanup;
  const point = (y: number, id = 1) => ({
    identifier: id,
    clientX: 50,
    clientY: y,
  });
  const touch = (
    kind: string,
    y: number,
    time: number,
    options: {
      target?: ElementStub;
      count?: number;
      cancelable?: boolean;
    } = {},
  ) => {
    const event = new Event(kind, { cancelable: options.cancelable ?? true });
    Object.defineProperties(event, {
      target: { value: options.target || name },
      timeStamp: { value: time },
      touches: {
        value:
          kind === "touchend" || kind === "touchcancel"
            ? []
            : options.count === 2
              ? [point(y), point(y, 2)]
              : [point(y)],
      },
      changedTouches: { value: [point(y)] },
    });
    panel.dispatchEvent(event);
    return event;
  };
  const click = (detail: number) => {
    const event = new Event("click", { cancelable: true });
    Object.defineProperty(event, "detail", { value: detail });
    panel.dispatchEvent(event);
    return event;
  };
  touch("touchstart", 0, 0);
  assert.ok(touch("touchmove", 30, 100).defaultPrevented);
  assert.equal(panel.properties.get("--dock-drag"), "30px");
  touch("touchend", 90, 300);
  assert.equal(closed, 1);
  assert.equal(panel.properties.size, 0);
  assert.ok(
    click(1).defaultPrevented,
    "the name under the finger is not activated after dragging",
  );
  assert.equal(
    click(0).defaultPrevented,
    false,
    "keyboard activation still works",
  );

  panel.scrollTop = 100;
  touch("touchstart", 0, 0);
  assert.equal(touch("touchmove", 40, 100).defaultPrevented, false);
  panel.scrollTop = 0;
  assert.equal(touch("touchmove", 110, 200).defaultPrevented, false);
  touch("touchend", 130, 300);
  assert.equal(
    closed,
    1,
    "scrolling to the top does not accidentally dismiss the card",
  );
  content.scrollTop = 20;
  touch("touchstart", 0, 0);
  assert.equal(touch("touchmove", 100, 200).defaultPrevented, false);
  touch("touchend", 100, 300);
  assert.equal(closed, 1, "an inner scrolling area keeps control");
  content.scrollTop = 0;

  touch("touchstart", 0, 0);
  touch("touchmove", 30, 100);
  touch("touchstart", 30, 120, { count: 2 });
  touch("touchend", 100, 200);
  assert.equal(closed, 1);
  assert.equal(panel.classes.size, 0);
  touch("touchstart", 0, 0);
  touch("touchmove", 30, 100);
  touch("touchcancel", 100, 200);
  assert.equal(closed, 1);
  assert.equal(panel.properties.size, 0);

  touch("touchstart", 0, 0);
  touch("touchmove", 90, 100, { cancelable: false });
  touch("touchend", 90, 200);
  assert.equal(closed, 1);
  name.blocked = true;
  touch("touchstart", 0, 0);
  assert.equal(touch("touchmove", 90, 100).defaultPrevented, false);
  touch("touchend", 90, 200);
  name.blocked = false;
  mobile = false;
  touch("touchstart", 0, 0);
  touch("touchmove", 100, 100);
  touch("touchend", 100, 200);
  assert.equal(closed, 1);

  mobile = true;
  touch("touchstart", 0, 0);
  touch("touchend", 0, 100);
  assert.equal(
    click(1).defaultPrevented,
    false,
    "ordinary taps remain available",
  );
  cleanup();
  touch("touchstart", 0, 0);
  touch("touchmove", 100, 100);
  touch("touchend", 100, 200);
  assert.equal(closed, 1, "listeners are removed on unmount");
});
