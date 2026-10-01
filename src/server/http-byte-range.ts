// Invalid or multipart ranges are ignored; a valid range outside the file is 416.
export function httpByteRange(
  header: string | undefined,
  size: number,
): { start: number; end: number } | "unsatisfiable" | undefined {
  const match = header?.match(/^bytes=(\d*)-(\d*)$/i);
  if (!match || (!match[1] && !match[2])) return;
  if (!match[1]) {
    const suffix = Number(match[2]);
    if (!suffix || !size) return "unsatisfiable";
    return { start: Math.max(0, size - suffix), end: size - 1 };
  }
  const start = Number(match[1]);
  const end = match[2] ? Number(match[2]) : size - 1;
  if (match[2] && end < start) return;
  if (start >= size) return "unsatisfiable";
  return { start, end: Math.min(end, size - 1) };
}
