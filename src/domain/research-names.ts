export function normalizeResearchText(value: string) {
  return value
    .normalize("NFKC")
    .trim()
    .toLocaleLowerCase("ru")
    .replaceAll("ё", "е")
    .replace(/\s+/g, " ");
}

/** Match grammatical variants against forms actually present in the archive. */
export function surnameKeys(value: string) {
  const word = normalizeResearchText(value);
  const keys = new Set([word]);
  if (word.length < 5) return keys;
  if (/(?:овых|евых|иных|ыных|овым|евым|иным|ыным)$/.test(word))
    keys.add(word.slice(0, -2));
  if (/(?:ова|ева|ина|ына)$/.test(word)) keys.add(word.slice(0, -1));
  if (/(?:овы|евы|ины|ыны)$/.test(word)) keys.add(word.slice(0, -1));
  if (/(?:ская|цкая)$/.test(word)) keys.add(`${word.slice(0, -2)}ий`);
  if (/(?:ая|яя)$/.test(word))
    for (const suffix of ["ый", "ий", "ой"])
      keys.add(`${word.slice(0, -2)}${suffix}`);
  if (/(?:ов|ев|ин|ын)$/.test(word)) keys.add(`${word}а`);
  if (/(?:ский|цкий)$/.test(word)) keys.add(`${word.slice(0, -2)}ая`);
  if (/(?:ый|ий|ой)$/.test(word)) keys.add(`${word.slice(0, -2)}ая`);
  return keys;
}
