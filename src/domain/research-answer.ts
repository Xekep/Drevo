export type ResearchAnswerReference =
  | { kind: "person"; id: string; label: string }
  | { kind: "photo"; id: string; label: string }
  | {
      kind: "source";
      personId: string;
      label: string;
      reference?: string;
      url?: string;
    };

/** A file is already attached to the chat message; remove model-written duplicates. */
export function cleanPdfAnswer(answer: string) {
  return answer
    .replace(
      /\[[^\]]+\]\((?:https?:\/\/[^\s)]*)?\/api\/ai\/files\/[^)]+\)/giu,
      "",
    )
    .replace(
      /(?:Вы можете скачать файл по ссылке|Скачать файл можно по ссылке|Ссылка на скачивание|Ссылка)\s*:\s*(?:`+\s*`+|(?:https?:\/\/[^\s)]*)?\/api\/ai\/files\/[^\s)]*)?/giu,
      "",
    )
    .replace(/(?:https?:\/\/[^\s)]*)?\/api\/ai\/files\/[a-f\d-]+/giu, "")
    .split(/\r?\n/)
    .map((line) => line.trimEnd())
    .filter((line, index, lines) => line.trim() || lines[index - 1]?.trim())
    .join("\n")
    .trim();
}

/** Repair a common model formatting error without changing the table data. */
export function normalizeResearchMarkdown(
  answer: string,
  verifiedMermaid = "",
  graphRequested = false,
) {
  let result = normalizeExternalResearchLinks(answer)
    .replace(/```(?:mermaid)?\s*\n\s*```/giu, "")
    .replace(/^\s*Не удалось построить схему\s*$/gimu, "")
    .replace(
      /^\|\s*ФИОДата рожденияМесто рожденияДата смертиПримечания\s*\|[^\n]*$/gimu,
      "| ФИО | Дата рождения | Место рождения | Дата смерти | Примечания |",
    );
  if (verifiedMermaid)
    result = result.replace(
      /```mermaid\s*\n\s*(?:graph|flowchart)\s[\s\S]*?```/giu,
      `\x60\x60\x60mermaid\n${verifiedMermaid}\n\x60\x60\x60`,
    );
  if (
    graphRequested &&
    verifiedMermaid &&
    !/```mermaid\s*\n\s*(?:graph|flowchart)\s/iu.test(result)
  )
    result += `\n\n\x60\x60\x60mermaid\n${verifiedMermaid}\n\x60\x60\x60`;
  return result.trim();
}

export function verifiedSurnameTable(
  people: Array<{
    id: string;
    name: string;
    birthSurname: string | null;
    birth: string | null;
    birthPlace: string | null;
    death: string | null;
  }>,
) {
  const cell = (value: string | null) =>
    (value || "—").replaceAll("|", "\\|").replaceAll(/\r?\n/g, " ");
  const heading =
    "| ФИО | Фамилия при рождении | Дата рождения | Место рождения | Дата смерти |\n| --- | --- | --- | --- | --- |";
  const rows = [...people]
    .sort((a, b) => a.name.localeCompare(b.name, "ru"))
    .map(
      (person) =>
        `| [[person:${person.id}|${cell(person.name)}]] | ${cell(person.birthSurname)} | ${cell(person.birth)} | ${cell(person.birthPlace)} | ${cell(person.death)} |`,
    );
  return [heading, ...rows].join("\n");
}

export function replaceResearchTable(answer: string, table: string) {
  const pattern = /(^|\n)\|[^\n]*\|\n\|[\s:|-]+\|\n(?:\|[^\n]*\|(?:\n|$))+/m;
  return pattern.test(answer)
    ? answer.replace(pattern, (_match, prefix: string) => `${prefix}${table}\n`)
    : `${answer.trim()}\n\n${table}`;
}

export function researchPdfFilename(title: string) {
  const short = title
    .split(/[:：]/, 1)[0]
    .replace(/[\\/:*?"<>|]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 48)
    .trim();
  return `${short || "Отчёт"}.pdf`;
}

const escapePattern = (value: string) =>
  value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

function outsideCodeFences(value: string, transform: (part: string) => string) {
  return value
    .split(/(```[\s\S]*?```)/g)
    .map((part, index) => (index % 2 ? part : transform(part)))
    .join("");
}

function markdownLink(label: string, href: string) {
  return `[${label.replaceAll("[", "\\[").replaceAll("]", "\\]")}](${href.replaceAll("(", "%28").replaceAll(")", "%29")})`;
}

/** Convert model-written wiki-style HTTP links to Markdown, including escaped colons. */
export function normalizeExternalResearchLinks(content: string) {
  return content
    .split(/(```[\s\S]*?```|`[^`\n]*`)/g)
    .map((part, index) =>
      index % 2
        ? part
        : part.replace(
            /\[\[((?:https?:|https?\\:)[^|\]\s]+)\|([^\]\n]+)\]\]/giu,
            (original, address: string, label: string) => {
              try {
                const url = new URL(
                  address.replaceAll("\\:", ":").replaceAll("\\/", "/"),
                );
                if (
                  !["http:", "https:"].includes(url.protocol) ||
                  url.username ||
                  url.password
                )
                  return original;
                return markdownLink(label.trim(), url.href);
              } catch {
                return original;
              }
            },
          ),
    )
    .join("");
}

/** Only verified references from the response are eligible for automatic links. */
export function linkResearchReferences(
  content: string,
  references: ResearchAnswerReference[] = [],
) {
  const placeholders: string[] = [];
  const reserve = (markdown: string) => {
    const token = `DREVOREF${placeholders.length}TOKEN`;
    placeholders.push(markdown);
    return token;
  };

  let value = outsideCodeFences(
    normalizeExternalResearchLinks(content),
    (part) => {
      let normalized = part;
      for (const match of part.matchAll(
        /\[\[(person|choose-person|photo):([^|\]\s]+)\|([^\]]+)\]\]/g,
      ))
        normalized = normalized.replace(
          new RegExp(
            `${escapePattern(match[3])}[ \\t\\u00a0]*\\(${escapePattern(match[0])}\\)`,
            "gu",
          ),
          match[0],
        );
      return normalized.replace(
        /\[\[(person|choose-person|photo):([^|\]\s]+)\|([^\]]+)\]\](?:[ \t\u00a0]+\3)?/g,
        (_marker, kind: string, id: string, label: string) =>
          reserve(
            markdownLink(label, `#drevo-${kind}-${encodeURIComponent(id)}`),
          ),
      );
    },
  );

  for (const reference of references) {
    if (reference.kind !== "photo") continue;
    value = outsideCodeFences(value, (part) =>
      part.replace(
        new RegExp(
          `!\\[([^\\]]*)\\]\\(${escapePattern(reference.id)}\\)`,
          "gu",
        ),
        (_whole, alt: string) =>
          reserve(
            markdownLink(
              alt.trim() || reference.label,
              `#drevo-photo-${encodeURIComponent(reference.id)}`,
            ),
          ),
      ),
    );
  }

  const candidates = references.flatMap((reference) => {
    const href =
      reference.kind === "person"
        ? `#drevo-person-${encodeURIComponent(reference.id)}`
        : reference.kind === "photo"
          ? `#drevo-photo-${encodeURIComponent(reference.id)}`
          : reference.url ||
            `#drevo-person-${encodeURIComponent(reference.personId)}`;
    const names = [reference.label];
    if (reference.kind === "person") {
      const [surname, first, patronymic] = reference.label.split(/\s+/);
      if (surname && first)
        names.push(`${surname} ${first}`, `${first} ${surname}`);
      if (surname && first && patronymic)
        names.push(`${first} ${patronymic} ${surname}`);
    }
    return names.map((name) => ({ name, href }));
  });
  const owners = new Map<string, Set<string>>();
  for (const { name, href } of candidates) {
    const key = name.toLocaleLowerCase("ru").replaceAll("ё", "е");
    const group = owners.get(key) || new Set<string>();
    group.add(href);
    owners.set(key, group);
  }
  const unique = candidates
    .filter(
      ({ name }) =>
        owners.get(name.toLocaleLowerCase("ru").replaceAll("ё", "е"))?.size ===
        1,
    )
    .sort((a, b) => b.name.length - a.name.length);

  value = outsideCodeFences(value, (part) =>
    part
      .split(/(\[[^\]]+\]\([^)]+\)|`[^`]*`|DREVOREF\d+TOKEN)/g)
      .map((segment, index) => {
        if (index % 2) return segment;
        let text = segment;
        for (const { name, href } of unique) {
          const spelling = escapePattern(name)
            .replaceAll("е", "[её]")
            .replaceAll("Е", "[ЕЁ]");
          text = text.replace(
            new RegExp(
              `(?<![\\p{L}\\p{N}])${spelling}(?![\\p{L}\\p{N}])`,
              "giu",
            ),
            (match) => reserve(markdownLink(match, href)),
          );
        }
        return text;
      })
      .join(""),
  );
  // Replacement may introduce links in earlier placeholders; restore them only
  // after all auto-linking has finished.
  placeholders.forEach((markdown, index) => {
    value = value.replaceAll(`DREVOREF${index}TOKEN`, () => markdown);
  });
  return value;
}
