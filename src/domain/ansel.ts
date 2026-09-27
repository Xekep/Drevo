/** GEDCOM 5.5.1, Appendix C. ANSEL puts combining marks before the base character. */
const spacing: Record<number, string> = {
  0xa1: "Ł",
  0xa2: "Ø",
  0xa3: "Đ",
  0xa4: "Þ",
  0xa5: "Æ",
  0xa6: "Œ",
  0xa8: "·",
  0xa9: "♭",
  0xaa: "®",
  0xab: "±",
  0xae: "ʾ",
  0xb0: "ʿ",
  0xb1: "ł",
  0xb2: "ø",
  0xb3: "đ",
  0xb4: "þ",
  0xb5: "æ",
  0xb6: "œ",
  0xb8: "ı",
  0xb9: "£",
  0xba: "ð",
  0xc3: "©",
  0xc5: "¿",
  0xc6: "¡",
  0xcf: "ß",
};
const combining: Record<number, string> = {
  0xe1: "\u0300",
  0xe2: "\u0301",
  0xe3: "\u0302",
  0xe4: "\u0303",
  0xe5: "\u0304",
  0xe6: "\u0306",
  0xe7: "\u0307",
  0xe8: "\u0308",
  0xe9: "\u030c",
  0xea: "\u030a",
  0xed: "\u0315",
  0xee: "\u030b",
  0xf0: "\u0327",
  0xf1: "\u0328",
  0xf6: "\u0332",
  0xfe: "\u0313",
};
export function decodeAnsel(bytes: Uint8Array): string {
  const result: string[] = [];
  let marks = "";
  for (const byte of bytes) {
    if (combining[byte]) {
      marks += combining[byte];
      continue;
    }
    const character = byte < 128 ? String.fromCharCode(byte) : spacing[byte];
    if (character === undefined || (marks && byte < 32))
      throw new Error(`Некорректный символ ANSEL: 0x${byte.toString(16)}`);
    result.push(character + marks);
    marks = "";
  }
  if (marks) throw new Error("Незавершённая диакритика ANSEL");
  return result.join("").normalize("NFC");
}
