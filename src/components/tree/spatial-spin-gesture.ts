type Sample = { x: number; y: number; time: number };
export type SpinDirection = -1 | 0 | 1;

/** A deliberate command, not inertia: speed only decides whether to start.
 * One fast horizontal stroke arms constant-speed rotation on release.
 */
export class SpatialSpinGesture {
  private pointers = new Set<number>();
  private stroke: {
    id: number;
    height: number;
    samples: Sample[];
    lastMove: number;
  } | null = null;

  begin(id: number, point: Sample, height: number, eligible: boolean) {
    this.pointers.add(id);
    this.stroke =
      this.pointers.size === 1 &&
      eligible &&
      height > 0 &&
      [point.x, point.y, point.time, height].every(Number.isFinite)
        ? { id, height, samples: [point], lastMove: point.time }
        : null;
  }
  move(id: number, point: Sample) {
    const stroke = this.stroke;
    if (!stroke || stroke.id !== id) return;
    const last = stroke.samples.at(-1)!;
    if (
      ![point.x, point.y, point.time].every(Number.isFinite) ||
      point.time < last.time
    ) {
      this.stroke = null;
      return;
    }
    if (point.x === last.x && point.y === last.y) return;
    stroke.lastMove = point.time;
    const samples = [...stroke.samples, point];
    let first = 0;
    while (
      first < samples.length - 1 &&
      samples[first + 1].time <= point.time - 180
    )
      first++;
    const recent = samples.slice(first);
    // Keep the boundary's predecessor: sparse events must not lose a whole
    // segment of a real fast stroke. Retain it even with high-rate pointer input.
    stroke.samples =
      recent.length > 64 ? [recent[0], ...recent.slice(-63)] : recent;
  }
  end(id: number, point: Sample): SpinDirection {
    this.move(id, point);
    const stroke = this.stroke;
    this.pointers.delete(id);
    this.stroke = null;
    if (
      !stroke ||
      stroke.id !== id ||
      this.pointers.size ||
      point.time - stroke.lastMove > 80
    )
      return 0;
    let index = 0;
    while (
      index < stroke.samples.length - 1 &&
      stroke.samples[index + 1].time <= point.time - 180
    )
      index++;
    let first = stroke.samples[index];
    const next = stroke.samples[index + 1];
    if (first.time < point.time - 180) {
      if (!next || next.time <= first.time) return 0;
      const fraction =
        (point.time - 180 - first.time) / (next.time - first.time);
      first = {
        x: first.x + (next.x - first.x) * fraction,
        y: first.y + (next.y - first.y) * fraction,
        time: point.time - 180,
      };
    }
    const elapsed = point.time - first.time,
      dx = point.x - first.x,
      dy = point.y - first.y;
    if (
      elapsed < 35 ||
      elapsed > 180 ||
      Math.abs(dx) < Math.max(96, stroke.height * 0.2) ||
      Math.abs(dx) < Math.abs(dy) * 1.5 ||
      Math.abs(dx) / stroke.height / (elapsed / 1000) < 1.2
    )
      return 0;
    return dx > 0 ? 1 : -1;
  }
  cancel(id?: number) {
    this.stroke = null;
    if (id === undefined) this.pointers.clear();
    else this.pointers.delete(id);
  }
}
