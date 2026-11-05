export type GpuMotionPoint = { x: number; y: number; opacity?: number };
export type GpuMotionItem = { id: string; position: GpuMotionPoint };

/** One texel per card/household, shared by its portrait and every glyph.
 * Texel zero belongs to lines/junctions, whose opacity follows the scene. */
export function createGpuMotion(items: readonly GpuMotionItem[]) {
  const indices = new Map(items.map((item, i) => [item.id, i + 1]));
  const width = 256,
    height = Math.ceil((items.length + 1) / width);
  const data = new Float32Array(width * height * 4);
  for (let i = 0; i <= items.length; i++) data[i * 4 + 2] = data[i * 4 + 3] = 1;
  let lastProgress = 1,
    leaving = false;
  return {
    width,
    height,
    data,
    get departing() {
      return leaving;
    },
    index: (id: string) => indices.get(id) || 0,
    progress(value: number) {
      lastProgress = value;
    },
    positions() {
      return new Map(
        items.map((item, i) => [
          item.id,
          {
            x:
              item.position.x +
              data[(i + 1) * 4] * (leaving ? 1 : 1 - lastProgress),
            y:
              item.position.y +
              data[(i + 1) * 4 + 1] * (leaving ? 1 : 1 - lastProgress),
            opacity:
              data[(i + 1) * 4 + 2] * (1 - lastProgress) +
              data[(i + 1) * 4 + 3] * lastProgress,
          },
        ]),
      );
    },
    relocate(target: ReadonlyMap<string, GpuMotionPoint>) {
      for (const [i, item] of items.entries()) {
        const point = target.get(item.id) || item.position, offset = (i + 1) * 4;
        data[offset] = point.x - item.position.x;
        data[offset + 1] = point.y - item.position.y;
        data[offset + 2] = data[offset + 3] = 1;
      }
      // A settled translation uses the same texel for portraits and labels.
      leaving = true;
      lastProgress = 1;
    },
    transition(other: ReadonlyMap<string, GpuMotionPoint>, departing: boolean) {
      for (const [i, item] of items.entries()) {
        const previous = other.get(item.id),
          offset = (i + 1) * 4;
        if (departing) {
          // Common cards are drawn only by the incoming scene. Disappearing
          // cards retain their current position if a flight was interrupted.
          data[offset] *= leaving ? 1 : 1 - lastProgress;
          data[offset + 1] *= leaving ? 1 : 1 - lastProgress;
          data[offset + 2] = previous
            ? 0
            : data[offset + 2] * (1 - lastProgress) +
              data[offset + 3] * lastProgress;
          data[offset + 3] = 0;
        } else {
          data[offset] = previous ? previous.x - item.position.x : 0;
          data[offset + 1] = previous ? previous.y - item.position.y : 0;
          data[offset + 2] = previous ? (previous.opacity ?? 1) : 0;
          data[offset + 3] = 1;
        }
      }
      leaving = departing;
      lastProgress = 0;
    },
  };
}
