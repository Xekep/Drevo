import { ancestorFanSlots, type Family } from "../../domain";
import { runFanReveal } from "./fan-reveal";

type Rect = {
  left: number;
  top: number;
  width: number;
  height: number;
};

export type FanMorphSource = {
  slot: string;
  generation: number;
  index: number;
  rect: Rect;
  node: HTMLElement;
};

export function captureFanMorphSources(
  container: HTMLElement,
  family: Family,
  anchorId: string,
): FanMorphSource[] {
  const canvas = container.getBoundingClientRect();
  const slots = ancestorFanSlots(family.people, anchorId, 5);
  const ancestors = new Set(slots.map((slot) => slot.personId));
  const cards = new Map<string, { rect: Rect; node: HTMLElement }>();

  for (const card of container.querySelectorAll<HTMLElement>(
    ".flow-person[data-person-id]",
  )) {
    const personId = card.dataset.personId;
    if (!personId || !ancestors.has(personId) || cards.has(personId)) continue;

    const node = card;
    const rect = node.getBoundingClientRect();
    if (
      rect.right < canvas.left ||
      rect.left > canvas.right ||
      rect.bottom < canvas.top ||
      rect.top > canvas.bottom
    )
      continue;

    const clone = node.cloneNode(true) as HTMLElement;
    for (const child of [...clone.children])
      if (!child.classList.contains("flow-person-content")) child.remove();
    clone.style.width = `${node.offsetWidth}px`;
    clone.style.height = `${node.offsetHeight}px`;
    clone.style.transformOrigin = "top left";
    clone.style.transform = `scale(${rect.width / Math.max(1, node.offsetWidth)})`;
    clone.removeAttribute("data-person-id");
    cards.set(personId, {
      node: clone,
      rect: {
        left: rect.left - canvas.left,
        top: rect.top - canvas.top,
        width: rect.width,
        height: rect.height,
      },
    });
  }

  return slots.flatMap((slot) => {
    if (!slot.personId) return [];
    const source = cards.get(slot.personId);
    if (!source) return [];
    return [
      {
        slot: `${slot.generation}:${slot.index}`,
        generation: slot.generation,
        index: slot.index,
        rect: source.rect,
        node: source.node.cloneNode(true) as HTMLElement,
      },
    ];
  });
}

const frame = () =>
  new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));

export async function runFanMorph(
  container: HTMLElement,
  sources: FanMorphSource[],
  signal: AbortSignal,
) {
  await frame();
  await frame();
  if (signal.aborted) return;

  const overlay = document.createElement("div");
  overlay.className = "fan-morph-overlay";
  overlay.setAttribute("aria-hidden", "true");
  overlay.inert = true;
  container.append(overlay);

  const animations: Animation[] = [];
  const cancel = () => {
    animations.forEach((animation) => animation.cancel());
    overlay.remove();
  };
  signal.addEventListener("abort", cancel, { once: true });
  for (const source of sources) {
    const label = container.querySelector<SVGGraphicsElement>(
      `[data-fan-slot="${source.slot}"] .fan-sector-label`,
    );
    if (!label) continue;

    const target = label.getBoundingClientRect();
    const canvas = container.getBoundingClientRect();
    const targetCenter = {
      x: target.left - canvas.left + target.width / 2,
      y: target.top - canvas.top + target.height / 2,
    };
    const sourceCenter = {
      x: source.rect.left + source.rect.width / 2,
      y: source.rect.top + source.rect.height / 2,
    };
    const dx = targetCenter.x - sourceCenter.x;
    const dy = targetCenter.y - sourceCenter.y;

    const targetWidth =
      source.generation <= 1 ? 102 : source.generation === 2 ? 82 : 64;
    const targetHeight =
      source.generation <= 1 ? 42 : source.generation === 2 ? 34 : 26;
    const scale = Math.min(
      1,
      targetWidth / Math.max(1, source.rect.width),
      targetHeight / Math.max(1, source.rect.height),
    );
    const arc = Math.min(72, 26 + Math.abs(dx) * 0.055);
    const count = 2 ** source.generation;
    const fanPosition =
      source.generation === 0 ? 0 : source.index / Math.max(1, count - 1) - 0.5;
    const rotation = fanPosition * 12;

    const ghost = document.createElement("div");
    ghost.className = "fan-morph-card";
    ghost.style.left = `${source.rect.left}px`;
    ghost.style.top = `${source.rect.top}px`;
    ghost.style.width = `${source.rect.width}px`;
    ghost.style.height = `${source.rect.height}px`;
    source.node.querySelectorAll("[id]").forEach((node) =>
      node.removeAttribute("id"),
    );
    source.node.setAttribute("tabindex", "-1");
    ghost.append(source.node);
    overlay.append(ghost);

    animations.push(
      ghost.animate(
        [
          {
            transform: "translate3d(0, 0, 0) scale(1) rotate(0deg)",
            opacity: 1,
          },
          {
            offset: 0.58,
            transform: `translate3d(${dx * 0.58}px, ${dy * 0.48 - arc}px, 0) scale(${1 - (1 - scale) * 0.58}) rotate(${rotation * 0.45}deg)`,
            opacity: 0.92,
          },
          {
            transform: `translate3d(${dx}px, ${dy}px, 0) scale(${scale}) rotate(${rotation}deg)`,
            opacity: 0,
          },
        ],
        {
          duration: 430 + source.generation * 18,
          delay: Math.min(72, source.generation * 14 + source.index * 3),
          easing: "cubic-bezier(0.2, 0.76, 0.22, 1)",
          fill: "forwards",
        },
      ),
    );
  }

  try {
    await Promise.all(animations.map((animation) => animation.finished));

    if (!signal.aborted) await runFanReveal(container, signal);
  } catch {
    // The transition may be cancelled by a rapid mode switch.
  } finally {
    signal.removeEventListener("abort", cancel);
    cancel();
  }
}
