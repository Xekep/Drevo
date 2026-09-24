import { ancestorFanSlots, type Family } from "../../domain";

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
  const cards = new Map<string, { rect: Rect; node: HTMLElement }>();

  for (const card of container.querySelectorAll<HTMLElement>(
    ".flow-person[data-person-id]",
  )) {
    const personId = card.dataset.personId;
    if (!personId || cards.has(personId)) continue;

    const node = card.querySelector<HTMLElement>(".flow-person-content");
    if (!node) continue;
    const rect = node.getBoundingClientRect();
    if (
      rect.right < canvas.left ||
      rect.left > canvas.right ||
      rect.bottom < canvas.top ||
      rect.top > canvas.bottom
    )
      continue;

    cards.set(personId, {
      node,
      rect: {
        left: rect.left - canvas.left,
        top: rect.top - canvas.top,
        width: rect.width,
        height: rect.height,
      },
    });
  }

  return ancestorFanSlots(family.people, anchorId, 5).flatMap((slot) => {
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
) {
  if (
    !sources.length ||
    window.matchMedia("(prefers-reduced-motion: reduce)").matches
  )
    return;

  await frame();
  await frame();

  const overlay = document.createElement("div");
  overlay.className = "fan-morph-overlay";
  overlay.setAttribute("aria-hidden", "true");
  container.append(overlay);

  const animations: Animation[] = [];
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

    const layerAnimations: Animation[] = [];
    for (let generation = 0; generation < 5; generation++) {
      const sectors = container.querySelectorAll<SVGGraphicsElement>(
        `[data-fan-generation="${generation}"]`,
      );
      for (const sector of sectors)
        layerAnimations.push(
          sector.animate(
            [
              { opacity: 0, filter: "blur(2px)" },
              { opacity: 1, filter: "blur(0)" },
            ],
            {
              duration: 190,
              delay: generation * 95,
              easing: "cubic-bezier(0.2, 0.75, 0.25, 1)",
              fill: "forwards",
            },
          ),
        );
    }

    const meta = container.querySelector<HTMLElement>(".fan-chart-meta");
    if (meta)
      layerAnimations.push(
        meta.animate(
          [
            { opacity: 0, transform: "translateY(5px)" },
            { opacity: 1, transform: "translateY(0)" },
          ],
          {
            duration: 180,
            delay: 4 * 95 + 120,
            easing: "ease-out",
            fill: "forwards",
          },
        ),
      );

    await Promise.all(layerAnimations.map((animation) => animation.finished));
  } catch {
    // The transition may be cancelled by a rapid mode switch.
  } finally {
    overlay.remove();
  }
}
