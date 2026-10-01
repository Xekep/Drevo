import assert from "node:assert/strict";
import { test } from "node:test";
import type { PDFDocumentProxy } from "pdfjs-dist";
import type { TextItem, TextStyle } from "pdfjs-dist/types/src/display/api";
import {
  buildSearchPage,
  findPageMatches,
  PdfTextSearch,
} from "../src/components/bookreader-pdf-search.ts";

const viewport = { transform: [1, 0, 0, -1, -10, 810], scale: 1 };
const styles: Record<string, TextStyle> = {
  font: {
    ascent: 0.8,
    descent: -0.2,
    vertical: false,
    fontFamily: "sans-serif",
  },
};
const item = (str: string, x = 20, y = 700, hasEOL = false): TextItem => ({
  str,
  dir: "ltr",
  transform: [10, 0, 0, 10, x, y],
  width: str.length * 5,
  height: 10,
  fontName: "font",
  hasEOL,
});

test("PDF search normalizes Cyrillic case, spaces and ligatures and preserves source offsets", () => {
  const page = buildSearchPage(
    [item("Родословная\u00a0  семьи oﬃce")],
    viewport,
    styles,
  );
  const [phrase] = findPageMatches(page, "РОДОСЛОВНАЯ семьи", 4);
  assert.equal(phrase.text, "{{{Родословная\u00a0  семьи}}} oﬃce");
  assert.equal(phrase.par[0].page, 4);
  const [ligature] = findPageMatches(page, "OFFICE", 4);
  assert.equal(ligature.text, "Родословная\u00a0  семьи {{{oﬃce}}}");
  assert.equal(findPageMatches(page, "missing", 4).length, 0);
  assert.equal(findPageMatches(page, "   ", 4).length, 0);
});

test("PDF search joins split glyph runs and finds phrases across line breaks", () => {
  const page = buildSearchPage(
    [item("Ар", 20, 700), item("хив", 30, 700, true), item("семьи", 20, 680)],
    viewport,
    styles,
  );
  assert.equal(page.text, "Архив семьи");
  const [match] = findPageMatches(page, "архив\nсемьи", 1);
  assert.equal(match.par[0].boxes.length, 3);
  assert.ok(match.par[0].boxes[2].t > match.par[0].boxes[0].b);
});

test("PDF match boxes account for partial text, crop origin and page rotation", () => {
  const page = buildSearchPage([item("Archive")], viewport, styles);
  const [match] = findPageMatches(page, "hiv", 2);
  assert.deepEqual(match.par[0].boxes[0], {
    page: 2,
    l: 25,
    r: 40,
    t: 102,
    b: 112,
  });
  const rotated = buildSearchPage(
    [item("Archive")],
    { transform: [0, 1, 1, 0, 0, 0], scale: 1 },
    styles,
  );
  assert.deepEqual(findPageMatches(rotated, "hiv", 2)[0].par[0].boxes[0], {
    page: 2,
    l: 698,
    r: 708,
    t: 35,
    b: 50,
  });
});

test("PDF search returns every occurrence with separate context and boxes", () => {
  const page = buildSearchPage(
    [item("archive then ARCHIVE")],
    viewport,
    styles,
  );
  const matches = findPageMatches(page, "archive", 1);
  assert.equal(matches.length, 2);
  assert.match(matches[0].text, /^\{\{\{archive\}\}\}/);
  assert.match(matches[1].text, /\{\{\{ARCHIVE\}\}\}$/);
  assert.ok(matches[1].par[0].boxes[0].l > matches[0].par[0].boxes[0].r);
});

function mockPdf(
  count: number,
  extract: (number: number) => Promise<TextItem[]>,
) {
  return {
    numPages: count,
    getPage: async (number: number) => ({
      getTextContent: async () => ({ items: await extract(number), styles }),
      getViewport: () => viewport,
    }),
  } as unknown as PDFDocumentProxy;
}

test("PDF text is extracted lazily, cached and searched in page order with at most two extractions", async () => {
  let calls = 0,
    active = 0,
    maximum = 0;
  const search = new PdfTextSearch(
    mockPdf(4, async (number) => {
      calls++;
      active++;
      maximum = Math.max(maximum, active);
      await new Promise((resolve) =>
        setTimeout(resolve, number === 1 ? 20 : 1),
      );
      active--;
      return [item(`Archive ${number}`)];
    }),
  );
  assert.equal(calls, 0);
  const results = await search.search("archive", new AbortController().signal);
  assert.deepEqual(
    results.matches.map((match) => match.par[0].page),
    [1, 2, 3, 4],
  );
  assert.equal(maximum, 2);
  assert.equal(calls, 4);
  assert.equal(results.hasText, true);
  assert.equal(
    (await search.search("Archive 4", new AbortController().signal)).matches
      .length,
    1,
  );
  assert.equal(calls, 4);
});

test("canceled PDF search stops reading further pages and cached text remains reusable", async () => {
  const request = new AbortController();
  let calls = 0;
  const search = new PdfTextSearch(
    mockPdf(10, async () => {
      calls++;
      await new Promise((resolve) => setTimeout(resolve, 5));
      request.abort();
      return [item("Archive")];
    }),
  );
  await assert.rejects(search.search("archive", request.signal), {
    name: "AbortError",
  });
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(calls, 2);
  const results = await search.search("archive", new AbortController().signal);
  assert.equal(results.matches.length, 10);
  assert.equal(calls, 10);
});

test("image-only PDF reports absence of text without starting OCR", async () => {
  const search = new PdfTextSearch(mockPdf(2, async () => []));
  const results = await search.search("archive", new AbortController().signal);
  assert.equal(results.hasText, false);
  assert.deepEqual(results.matches, []);
});
