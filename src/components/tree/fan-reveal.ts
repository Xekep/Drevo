const frame = () =>
  new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));

export async function runFanReveal(container: HTMLElement) {
  await frame();
  await frame();

  const animations: Animation[] = [];
  for (let generation = 0; generation < 5; generation++) {
    const sectors = container.querySelectorAll<SVGGraphicsElement>(
      `[data-fan-generation="${generation}"]`,
    );
    for (const sector of sectors)
      animations.push(
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
    animations.push(
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

  try {
    await Promise.all(animations.map((animation) => animation.finished));
  } catch {
    // A rapid mode switch can cancel the reveal.
  }
}
