export type GpuTextLine = { value: string; width: number };

/** Same glyph-by-glyph wrapping as the GPU renderer, without measuring every prefix. */
export function layoutGpuText(
  value: string,
  maxWidth: number,
  maxLines: number,
  advance: (letter: string) => number,
): GpuTextLine[] {
  const advances = new Map<string, number>();
  const widthOf = (letter: string) => {
    let width = advances.get(letter);
    if (width === undefined) {
      width = advance(letter);
      advances.set(letter, width);
    }
    return width;
  };
  // Sum in source order, including after a word moves to the next row. Using
  // subtraction of cumulative widths would change floating-point wrap edges.
  const measure = (letters: readonly string[]) =>
    letters.reduce((sum, letter) => sum + widthOf(letter), 0);
  const rows: GpuTextLine[] = [];
  let row: string[] = [],
    width = 0,
    space = -1;
  for (const letter of value) {
    const letterWidth = widthOf(letter);
    const nextWidth = width + letterWidth;
    if (row.length && nextWidth > maxWidth) {
      if (space > 0) {
        const before = row.slice(0, space);
        rows.push({ value: before.join(""), width: measure(before) });
        row = row.slice(space + 1);
        width = measure(row);
      } else {
        rows.push({ value: row.join(""), width });
        row = [];
        width = 0;
      }
      // The suffix after the last space contains no spaces.
      space = -1;
    }
    if (letter === " ") space = row.length;
    row.push(letter);
    width += letterWidth;
  }
  if (row.length) rows.push({ value: row.join(""), width });
  if (rows.length > maxLines) {
    const letters = [...rows[maxLines - 1].value];
    const widths = [0];
    for (const letter of letters) widths.push(widths.at(-1)! + widthOf(letter));
    const ellipsis = widthOf("…");
    let keep = letters.length;
    while (keep && widths[keep] + ellipsis > maxWidth) keep--;
    rows[maxLines - 1] = {
      value: letters.slice(0, keep).join("") + "…",
      width: widths[keep] + ellipsis,
    };
  }
  return rows.slice(0, maxLines);
}
