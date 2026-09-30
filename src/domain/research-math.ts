/** Accept TeX delimiters often used by models alongside remark-math's dollar syntax. */
export function normalizeResearchMath(markdown: string) {
  const rewrite = (source: string) => {
    let result = "";
    for (let index = 0; index < source.length;) {
      if (source[index] === "`") {
        const run = /^`+/.exec(source.slice(index))![0];
        const end = source.indexOf(run, index + run.length);
        if (end !== -1) {
          result += source.slice(index, end + run.length);
          index = end + run.length;
          continue;
        }
      }
      const opening = source.slice(index, index + 2);
      if (
        (opening === "\\(" || opening === "\\[") &&
        (index === 0 || source[index - 1] !== "\\")
      ) {
        const display = opening === "\\[";
        const closing = display ? "\\]" : "\\)";
        const end = source.indexOf(closing, index + 2);
        const formula = end === -1 ? "" : source.slice(index + 2, end).trim();
        if (formula) {
          result += display
            ? `\n\n$$\n${formula}\n$$\n\n`
            : `$${formula.replace(/\r?\n/g, " ")}$`;
          index = end + 2;
          continue;
        }
      }
      result += source[index];
      index++;
    }
    return result;
  };

  let result = "",
    prose = "",
    fence: { marker: string; length: number } | null = null;
  const flush = () => {
    result += rewrite(prose);
    prose = "";
  };
  for (const line of markdown.match(/[^\n]*\n|[^\n]+$/g) || []) {
    const content = line.replace(/\r?\n$/, "");
    if (fence) {
      result += line;
      if (
        new RegExp(`^ {0,3}${fence.marker}{${fence.length},}[ \t]*$`).test(
          content,
        )
      )
        fence = null;
      continue;
    }
    const opening = /^ {0,3}(`{3,}|~{3,})/.exec(content);
    if (opening || /^(?: {4}|\t)/.test(line)) {
      flush();
      result += opening
        ? line.replace(
            /^( {0,3}(?:`{3,}|~{3,}))(?:latex|tex)(?=\s|$)/i,
            "$1math",
          )
        : line;
      if (opening) fence = { marker: opening[1][0], length: opening[1].length };
    } else prose += line;
  }
  flush();
  return result;
}
