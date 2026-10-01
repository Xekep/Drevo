import type { PDFDocumentProxy } from "pdfjs-dist";
import type { TextItem, TextStyle } from "pdfjs-dist/types/src/display/api";

export type SearchBox = {
  page: number;
  l: number;
  t: number;
  r: number;
  b: number;
};
export type SearchMatch = {
  text: string;
  par: { page: number; boxes: SearchBox[] }[];
};
export type SearchResults = {
  q: string;
  indexed: boolean;
  matches: SearchMatch[];
  hasText: boolean;
  error?: string;
};

type Span = { start: number; end: number; item: TextItem };
export type SearchPage = {
  text: string;
  normalized: string;
  offsets: number[];
  spans: Span[];
  transform: number[];
  scale: number;
  styles: Record<string, TextStyle>;
};

function normalize(text: string) {
  let normalized = "";
  const offsets: number[] = [];
  let offset = 0;
  for (const character of text) {
    const replacement = character.normalize("NFKC").toLowerCase();
    for (const part of replacement) {
      const value = /\s/u.test(part) ? " " : part;
      if (value !== " " || !normalized.endsWith(" ")) {
        normalized += value;
        for (let index = 0; index < value.length; index++) offsets.push(offset);
      }
    }
    offset += character.length;
  }
  offsets.push(text.length);
  return { normalized, offsets };
}

export function buildSearchPage(
  items: TextItem[],
  viewport: { transform: number[]; scale: number },
  styles: Record<string, TextStyle>,
): SearchPage {
  let text = "";
  const spans: Span[] = [];
  let previous: TextItem | undefined;
  for (const item of items) {
    if (!item.str) continue;
    if (previous && !/\s$/u.test(text) && !/^\s/u.test(item.str)) {
      const [a, b, , , x, y] = previous.transform;
      const length = Math.hypot(a, b) || 1;
      const dx = item.transform[4] - x;
      const dy = item.transform[5] - y;
      const along = (dx * a + dy * b) / length;
      const across = Math.abs((dx * b - dy * a) / length);
      if (
        previous.hasEOL ||
        across > length / 2 ||
        along - previous.width > length / 10
      )
        text += " ";
    }
    const start = text.length;
    text += item.str;
    spans.push({ start, end: text.length, item });
    previous = item;
  }
  return { text, ...normalize(text), spans, ...viewport, styles };
}

function matchBox(
  page: SearchPage,
  span: Span,
  start: number,
  end: number,
  number: number,
): SearchBox {
  const [a, b, c, d, e, f] = page.transform;
  const [ta, tb, tc, td, tx, ty] = span.item.transform;
  let dx = a * ta + c * tb;
  let dy = b * ta + d * tb;
  const style = page.styles[span.item.fontName];
  if (style?.vertical) [dx, dy] = [-dy, dx];
  const length = Math.hypot(dx, dy) || 1;
  dx /= length;
  dy /= length;
  const fontHeight = Math.hypot(a * tc + c * td, b * tc + d * td);
  const ascent = style?.ascent ?? 0.8;
  const descent = style?.descent ?? -0.2;
  const x = a * tx + c * ty + e;
  const y = b * tx + d * ty + f;
  const width = span.item.width * page.scale;
  const left =
    (Math.max(start, span.start) - span.start) / span.item.str.length;
  const right = (Math.min(end, span.end) - span.start) / span.item.str.length;
  const corners = [left, right].flatMap((position) =>
    [ascent, descent].map((height) => ({
      x: x + dx * width * position + dy * fontHeight * height,
      y: y + dy * width * position - dx * fontHeight * height,
    })),
  );
  return {
    page: number,
    l: Math.min(...corners.map((corner) => corner.x)),
    r: Math.max(...corners.map((corner) => corner.x)),
    t: Math.min(...corners.map((corner) => corner.y)),
    b: Math.max(...corners.map((corner) => corner.y)),
  };
}

export function findPageMatches(
  page: SearchPage,
  query: string,
  number: number,
): SearchMatch[] {
  const term = normalize(query).normalized.trim();
  if (!term) return [];
  const matches: SearchMatch[] = [];
  let position = 0;
  while ((position = page.normalized.indexOf(term, position)) !== -1) {
    const start = page.offsets[position];
    const last = page.offsets[position + term.length - 1];
    const end =
      last + String.fromCodePoint(page.text.codePointAt(last)!).length;
    const boxes = page.spans
      .filter((span) => span.start < end && span.end > start)
      .map((span) => matchBox(page, span, start, end, number));
    if (boxes.length)
      matches.push({
        text:
          (start > 80 ? "…" : "") +
          page.text.slice(Math.max(0, start - 80), start) +
          "{{{" +
          page.text.slice(start, end) +
          "}}}" +
          page.text.slice(end, end + 80) +
          (end + 80 < page.text.length ? "…" : ""),
        par: [{ page: number, boxes }],
      });
    position += term.length;
  }
  return matches;
}

/** Extract only on demand, cache text in this iframe, and stop scanning when a search is canceled. */
export class PdfTextSearch {
  private pages = new Map<number, Promise<SearchPage>>();
  private active = 0;
  private waiting: (() => void)[] = [];

  private readonly pdf: PDFDocumentProxy;

  constructor(pdf: PDFDocumentProxy) {
    this.pdf = pdf;
  }

  private page(number: number): Promise<SearchPage> {
    const existing = this.pages.get(number);
    if (existing) return existing;
    const task = (async () => {
      if (this.active >= 2)
        await new Promise<void>((resolve) => this.waiting.push(resolve));
      else this.active++;
      try {
        const page = await this.pdf.getPage(number);
        const content = await page.getTextContent();
        return buildSearchPage(
          content.items.filter((item): item is TextItem => "str" in item),
          page.getViewport({ scale: 1 }),
          content.styles,
        );
      } finally {
        const next = this.waiting.shift();
        if (next) next();
        else this.active--;
      }
    })();
    this.pages.set(number, task);
    void task.catch(() => this.pages.delete(number));
    return task;
  }

  async search(query: string, signal: AbortSignal): Promise<SearchResults> {
    const matches: SearchMatch[][] = Array(this.pdf.numPages);
    let number = 1;
    let hasText = false;
    await Promise.all(
      Array.from({ length: Math.min(2, this.pdf.numPages) }, async () => {
        while (number <= this.pdf.numPages) {
          signal.throwIfAborted();
          const current = number++;
          const page = await this.page(current);
          signal.throwIfAborted();
          hasText ||= Boolean(page.normalized.trim());
          matches[current - 1] = findPageMatches(page, query, current);
          // Yield even when every page is cached so typing/cancel remains responsive.
          await new Promise<void>((resolve) => setTimeout(resolve, 0));
        }
      }),
    );
    return { q: query, indexed: true, matches: matches.flat(), hasText };
  }
}
