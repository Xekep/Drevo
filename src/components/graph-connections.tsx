import { useEffect, useRef } from "react";
import {
  position as basePosition,
  NODE_WIDTH,
  NODE_HEIGHT,
  type Person,
  type FamilyLink,
} from "../domain";

export function Connections({
  people,
  startYear,
  height: WORLD_HEIGHT,
  links,
  highlighted,
  width,
}: {
  people: Person[];
  startYear: number;
  height: number;
  links?: FamilyLink[];
  highlighted: string[];
  width: number;
}) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const position = (p: Person) => basePosition(p, startYear);
    const canvas = ref.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    const ratio = Math.min(window.devicePixelRatio || 1, 2);
    canvas.width = width * ratio;
    canvas.height = WORLD_HEIGHT * ratio;
    ctx.scale(ratio, ratio);
    ctx.clearRect(0, 0, width, WORLD_HEIGHT);
    const map = new Map(people.map((p) => [p.id, p]));
    function line(from: Person, to: Person, marriage: boolean) {
      const p = position(from),
        q = position(to);
      const match = highlighted.some(
        (id, i) =>
          i > 0 &&
          ((id === to.id && highlighted[i - 1] === from.id) ||
            (id === from.id && highlighted[i - 1] === to.id)),
      );
      ctx!.strokeStyle = match
        ? "#527561"
        : highlighted.length
          ? "#e1e6dd"
          : marriage
            ? "#b8bba8"
            : "#c6cfbd";
      ctx!.lineWidth = match ? 2.3 : 1.2;
      ctx!.setLineDash(marriage ? [3, 4] : []);
      ctx!.beginPath();
      if (marriage) {
        const left = p.x < q.x ? p : q,
          right = p.x < q.x ? q : p;
        const x = (left.x + NODE_WIDTH + right.x) / 2;
        ctx!.moveTo(left.x + NODE_WIDTH, left.y + 43);
        ctx!.lineTo(x, left.y + 43);
        ctx!.lineTo(x, right.y + 43);
        ctx!.lineTo(right.x, right.y + 43);
      } else {
        const sx = p.x + NODE_WIDTH / 2,
          sy = p.y + NODE_HEIGHT;
        const ex = q.x + NODE_WIDTH / 2,
          ey = q.y;
        const mid = sy + Math.max(18, (ey - sy) * 0.52);
        ctx!.moveTo(sx, sy);
        ctx!.lineTo(sx, mid);
        ctx!.lineTo(ex, mid);
        ctx!.lineTo(ex, ey);
      }
      ctx!.stroke();
      if (!marriage) {
        ctx!.setLineDash([]);
        ctx!.fillStyle = ctx!.strokeStyle;
        ctx!.beginPath();
        ctx!.arc(q.x + NODE_WIDTH / 2, q.y - 3, 2.3, 0, Math.PI * 2);
        ctx!.fill();
      }
    }
    for (const link of links || [])
      if (map.has(link.from) && map.has(link.to))
        line(map.get(link.from)!, map.get(link.to)!, true);
    const drawn = new Set<string>();
    for (const p of people) {
      for (const parent of p.parents)
        if (map.has(parent)) line(map.get(parent)!, p, false);
      for (const spouse of p.spouses) {
        const key = [p.id, spouse].sort().join(":");
        if (!drawn.has(key) && map.has(spouse)) {
          line(p, map.get(spouse)!, true);
          drawn.add(key);
        }
      }
    }
  }, [people, highlighted, width, startYear, WORLD_HEIGHT, links]);
  return (
    <canvas
      ref={ref}
      className="connections"
      style={{ width, height: WORLD_HEIGHT }}
      aria-hidden="true"
    />
  );
}
