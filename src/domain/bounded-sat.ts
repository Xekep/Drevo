// Integer literals use 1-based variables; a negative literal is a negation.
/** Deterministic CDCL with a shared work budget. Unknown never means unsatisfiable. */
export function solveBoundedSat(
  count: number,
  input: readonly (readonly number[])[],
  hints: readonly number[],
  budget: { remaining: number },
) {
  const clauses = input.map((c) => [...c]),
    watches = Array.from({ length: 2 * count + 2 }, (): number[] => []);
  const values = new Int8Array(count + 1),
    levels = new Int32Array(count + 1),
    reason = new Int32Array(count + 1).fill(-1),
    activity = new Float64Array(count + 1),
    phase = new Int8Array(count + 1).fill(-1);
  const trail: number[] = [],
    limits: number[] = [],
    index = (l: number) => (l > 0 ? 2 * l : 2 * -l + 1),
    value = (l: number) => values[Math.abs(l)] * (l > 0 ? 1 : -1);
  let head = 0,
    increment = 1,
    conflicts = 0,
    learnedLiterals = 0,
    restartAt = 100;
  for (let i = 1; i <= count; i++) if (hints[i]) phase[i] = hints[i];
  function assign(l: number, r: number) {
    const v = Math.abs(l);
    values[v] = l > 0 ? 1 : -1;
    phase[v] = values[v];
    levels[v] = limits.length;
    reason[v] = r;
    trail.push(l);
  }
  function attach(c: number[], i: number) {
    if (c.length === 1) {
      if (value(c[0]) < 0) return false;
      if (!value(c[0])) assign(c[0], i);
    } else {
      watches[index(c[0])].push(i);
      watches[index(c[1])].push(i);
    }
    return true;
  }
  for (let i = 0; i < clauses.length; i++) {
    if (!clauses[i].length) return null;
    if (!attach(clauses[i], i)) return null;
    for (const l of clauses[i]) activity[Math.abs(l)]++;
  }
  function propagate() {
    while (head < trail.length) {
      const falseLit = -trail[head++],
        list = watches[index(falseLit)];
      let out = 0;
      for (let k = 0; k < list.length; k++) {
        if (--budget.remaining < 0) return -2;
        const ci = list[k],
          c = clauses[ci];
        if (c[0] === falseLit) [c[0], c[1]] = [c[1], c[0]];
        if (value(c[0]) > 0) {
          list[out++] = ci;
          continue;
        }
        let replacement = -1;
        for (let j = 2; j < c.length; j++) {
          if (--budget.remaining < 0) return -2;
          if (value(c[j]) >= 0) {
            replacement = j;
            break;
          }
        }
        if (replacement >= 0) {
          [c[1], c[replacement]] = [c[replacement], c[1]];
          watches[index(c[1])].push(ci);
          continue;
        }
        list[out++] = ci;
        if (value(c[0]) < 0) {
          for (k++; k < list.length; k++) list[out++] = list[k];
          list.length = out;
          return ci;
        }
        assign(c[0], ci);
      }
      list.length = out;
    }
    return -1;
  }
  function backtrack(level: number) {
    if (limits.length <= level) return;
    const end = limits[level];
    for (let i = trail.length - 1; i >= end; i--) {
      values[Math.abs(trail[i])] = 0;
      reason[Math.abs(trail[i])] = -1;
    }
    trail.length = end;
    limits.length = level;
    head = end;
  }
  for (;;) {
    const conflict = propagate();
    if (conflict === -2) return;
    if (conflict >= 0) {
      if (!limits.length) return null;
      if (++conflicts > 4096) return;
      const learnt = [0],
        seen = new Uint8Array(count + 1);
      let open = 0,
        p = 0,
        at = trail.length - 1,
        clause = clauses[conflict];
      do {
        for (const l of clause) {
          if (--budget.remaining < 0) return;
          const v = Math.abs(l);
          if (v === Math.abs(p) || seen[v] || !levels[v]) continue;
          seen[v] = 1;
          activity[v] += increment;
          if (levels[v] === limits.length) open++;
          else learnt.push(l);
        }
        while (!seen[Math.abs(trail[at])]) {
          if (--budget.remaining < 0) return;
          at--;
        }
        p = trail[at--];
        seen[Math.abs(p)] = 0;
        open--;
        clause = clauses[reason[Math.abs(p)]];
      } while (open > 0);
      learnt[0] = -p;
      learnedLiterals += learnt.length;
      if (learnedLiterals > 100_000) return;
      let target = 0;
      for (let i = 1; i < learnt.length; i++)
        target = Math.max(target, levels[Math.abs(learnt[i])]);
      backtrack(target);
      const ci = clauses.length;
      clauses.push(learnt);
      if (learnt.length > 1) {
        watches[index(learnt[0])].push(ci);
        watches[index(learnt[1])].push(ci);
      }
      assign(learnt[0], ci);
      increment /= 0.95;
      if (increment > 1e100) {
        for (let v = 1; v <= count; v++) activity[v] *= 1e-100;
        increment *= 1e-100;
      }
      if (conflicts >= restartAt) {
        backtrack(0);
        restartAt = conflicts + Math.ceil(restartAt * 0.5);
      }
    } else {
      let choice = 0;
      for (let v = 1; v <= count; v++) {
        --budget.remaining;
        if (!values[v] && (!choice || activity[v] > activity[choice]))
          choice = v;
      }
      if (budget.remaining < 0) return;
      if (!choice) return values;
      limits.push(trail.length);
      assign(choice * phase[choice], -1);
    }
  }
}
