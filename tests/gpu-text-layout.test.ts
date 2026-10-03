import assert from "node:assert/strict";
import test from "node:test";
import { layoutGpuText } from "../src/components/tree/gpu-text-layout.ts";

// Frozen reference from the renderer before its prefix-measurement optimization.
function legacyLayout(
  value: string,
  maxWidth: number,
  maxLines: number,
  advance: (letter: string) => number,
) {
  const measure = (s: string) =>
    [...s].reduce((sum, letter) => sum + advance(letter), 0);
  const rows: string[] = [];
  let row = "";
  for (const letter of [...value]) {
    if (row && measure(row + letter) > maxWidth) {
      const space = row.lastIndexOf(" ");
      if (space > 0) {
        rows.push(row.slice(0, space));
        row = row.slice(space + 1) + letter;
      } else {
        rows.push(row);
        row = letter;
      }
    } else row += letter;
  }
  if (row) rows.push(row);
  if (rows.length > maxLines) {
    let last = rows[maxLines - 1];
    while (last && measure(last + "…") > maxWidth)
      last = [...last].slice(0, -1).join("");
    rows[maxLines - 1] = last + "…";
  }
  return rows
    .slice(0, maxLines)
    .map((line) => ({ value: line, width: measure(line) }));
}

const advance = (letter: string) =>
  letter === " "
    ? 4.1
    : letter === "…"
      ? 9.3
      : 3.7 + (letter.codePointAt(0)! % 19) / 7;

test("GPU wrapping preserves legacy lines, ellipsis and exact centered/right glyph positions", () => {
  const names = [
    "",
    "А",
    " ",
    "   ",
    "  Иван Иванович  ",
    "Достоевский-Волконский Александр Константинович",
    "Оченьдлиннаяфамилиябезпробелов Оченьдлинноеотчество",
    "А  Б   В    Г",
    "😀Иван 🧑🏽‍🔬 Сергеевич 🚀",
    "𐐀 𐐁𐐂 𐐃",
    "Иван\nИванович\tПетров",
    "год 1900—2000 · брат матери",
  ];
  for (const value of names)
    for (const width of [0, 1, 4.1, 9.3, 25, 61.4, 204, 10000])
      for (const maxLines of [1, 2, 3]) {
        const expected = legacyLayout(value, width, maxLines, advance);
        const actual = layoutGpuText(value, width, maxLines, advance);
        assert.deepEqual(
          actual,
          expected,
          JSON.stringify({ value, width, maxLines }),
        );
        for (const right of [false, true]) {
          const vertices = (lines: typeof actual) =>
            lines.map((line, index) => {
              let x =
                317.25 +
                (right
                  ? width + 16 - 14 - line.width
                  : (width + 16 - line.width) / 2);
              return [...line.value].map((letter) => {
                const point = { letter, x, y: 142.5 + index * 23 };
                x += advance(letter);
                return point;
              });
            });
          assert.deepEqual(vertices(actual), vertices(expected));
        }
      }
});

test("GPU wrapping preserves floating-point boundary choices for deterministic varied text", () => {
  let state = 731;
  const random = () => (state = (Math.imul(state, 1664525) + 1013904223) >>> 0);
  const alphabet = [..."АБab 😀𐐀"];
  for (let i = 0; i < 600; i++) {
    const value = Array.from(
      { length: 1 + (random() % 120) },
      () => alphabet[random() % alphabet.length],
    ).join("");
    const scale = [12 / 64, 15 / 64, 16 / 64, 22 / 64, 29 / 64][i % 5];
    const scaled = (letter: string) => advance(letter) * scale;
    // Include an exact prefix sum and its neighboring representable boundary.
    const prefix = [...value].slice(0, 3 + (random() % 12));
    const width = prefix.reduce((sum, letter) => sum + scaled(letter), 0);
    for (const maxWidth of [
      width,
      width - Number.EPSILON * Math.max(1, width),
      width + 0.001,
    ])
      assert.deepEqual(
        layoutGpuText(value, maxWidth, 1 + (i % 3), scaled),
        legacyLayout(value, maxWidth, 1 + (i % 3), scaled),
        JSON.stringify({ i, value, maxWidth, scale }),
      );
  }
});

test("GPU long names require at most one advance lookup per distinct codepoint and ellipsis", () => {
  const value = "😀Иван Петрович ".repeat(1600);
  for (const width of [204, 1000000]) {
    let calls = 0;
    const lines = layoutGpuText(value, width, 2, (letter) => {
      calls++;
      return advance(letter);
    });
    assert.ok(lines.length > 0 && lines.length <= 2);
    assert.ok(
      calls <= new Set([...value, "…"]).size,
      `advance calls: ${calls}`,
    );
  }
});
