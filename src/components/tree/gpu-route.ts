export type GpuSegment = {
  ax: number;
  ay: number;
  bx: number;
  by: number;
  distance: number;
};

/** Keep the M gaps produced by route bridging; dash phase restarts at each subpath. */
export function gpuRoute(path: string): GpuSegment[] {
  const tokens = path.match(/[A-Za-z]|-?\d*\.?\d+(?:e[+-]?\d+)?/g) || [];
  const segments: GpuSegment[] = [];
  let index = 0,
    x = 0,
    y = 0,
    distance = 0;
  const number = () => {
    const value = Number(tokens[index++]);
    if (!Number.isFinite(value)) throw new Error("Invalid GPU route");
    return value;
  };
  const line = (bx: number, by: number) => {
    const length = Math.hypot(bx - x, by - y);
    if (length) segments.push({ ax: x, ay: y, bx, by, distance });
    distance += length;
    x = bx;
    y = by;
  };
  while (index < tokens.length) {
    const command = tokens[index++];
    if (command === "M") {
      x = number();
      y = number();
      distance = 0;
    } else if (command === "L") line(number(), number());
    else if (command === "Q") {
      const cx = number(),
        cy = number(),
        bx = number(),
        by = number(),
        ax = x,
        ay = y;
      for (let step = 1; step <= 8; step++) {
        const t = step / 8,
          s = 1 - t;
        line(
          s * s * ax + 2 * s * t * cx + t * t * bx,
          s * s * ay + 2 * s * t * cy + t * t * by,
        );
      }
    } else throw new Error(`Unsupported GPU route: ${command}`);
  }
  return segments;
}
