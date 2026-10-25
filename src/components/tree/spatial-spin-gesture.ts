type Sample = { x: number; y: number; time: number };
export type SpinDirection = -1 | 0 | 1;
const WINDOW_MS = 180;
const RELEASE_GRACE_MS = 200;
type Stroke = {
  id: number;
  height: number;
  samples: Sample[];
  lastMove: number;
  armed: { direction: SpinDirection; time: number } | null;
};

function direction(stroke: Stroke, point: Sample): SpinDirection {
  let first = stroke.samples[0];
  const next = stroke.samples[1];
  if (first.time < point.time - WINDOW_MS) {
    if (!next || next.time <= first.time) return 0;
    const fraction = (point.time - WINDOW_MS - first.time) / (next.time - first.time);
    first = {
      x: first.x + (next.x - first.x) * fraction,
      y: first.y + (next.y - first.y) * fraction,
      time: point.time - WINDOW_MS,
    };
  }
  const elapsed = point.time - first.time;
  const dx = point.x - first.x, dy = point.y - first.y;
  const distance = Math.max(80, Math.min(180, stroke.height * 0.14));
  if (elapsed < 16 || elapsed > WINDOW_MS || Math.abs(dx) < distance ||
      Math.abs(dx) < Math.abs(dy) * 1.5 ||
      Math.abs(dx) / stroke.height / (elapsed / 1000) < 0.9) return 0;
  return dx > 0 ? 1 : -1;
}

/** A deliberate command, not inertia: speed only decides whether to start.
 * One fast horizontal stroke arms constant-speed rotation on release.
 */
export class SpatialSpinGesture {
  private pointers = new Set<number>();
  private stroke: Stroke | null = null;

  begin(id: number, point: Sample, height: number, eligible: boolean) {
    this.pointers.add(id);
    this.stroke =
      this.pointers.size === 1 &&
      eligible &&
      height > 0 &&
      [point.x, point.y, point.time, height].every(Number.isFinite)
        ? { id, height, samples: [point], lastMove: point.time, armed: null }
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
      samples[first + 1].time <= point.time - WINDOW_MS
    )
      first++;
    const recent = samples.slice(first);
    // Keep the boundary's predecessor: sparse events must not lose a whole
    // segment of a real fast stroke. Retain it even with high-rate pointer input.
    stroke.samples =
      recent.length > 64 ? [recent[0], ...recent.slice(-63)] : recent;
    const dx = point.x - last.x;
    if (stroke.armed && dx * stroke.armed.direction < -16) stroke.armed = null;
    const command = direction(stroke, point);
    if (command && Math.sign(dx) === command)
      stroke.armed = { direction: command, time: point.time };
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
      point.time - stroke.lastMove > RELEASE_GRACE_MS ||
      !stroke.armed || point.time - stroke.armed.time > RELEASE_GRACE_MS
    )
      return 0;
    return stroke.armed.direction;
  }
  cancel(id?: number) {
    this.stroke = null;
    if (id === undefined) this.pointers.clear();
    else this.pointers.delete(id);
  }
}
