export type ResearchAnswerReference =
  | {
      kind: "web";
      label: string;
      url: string;
      domain: string;
      snippet: string;
      sourceName?: string;
    }
  | { kind: "person"; id: string; label: string }
  | { kind: "photo"; id: string; label: string }
  | {
      kind: "source";
      personId: string;
      label: string;
      reference?: string;
      url?: string;
    };

/** Model/history hrefs are untrusted; decode once and never throw in render. */
export function researchInternalLink(href: string): {
  kind: "person" | "choose-person" | "photo";
  id: string;
} | null {
  const match = /^#drevo-(person|choose-person|photo)-(.+)$/.exec(href);
  if (!match || match[2].length > 1200) return null;
  try {
    const id = decodeURIComponent(match[2]);
    if (
      !id ||
      id.length > 100 ||
      id === "." ||
      id === ".." ||
      /[\p{Cc}/%\\]/u.test(id)
    )
      return null;
    return { kind: match[1] as "person" | "choose-person" | "photo", id };
  } catch {
    return null;
  }
}

/** Keep provider tool identifiers out of otherwise valid user-facing prose. */
export function hideResearchToolNames(
  answer: string,
  toolNames: ReadonlySet<string>,
) {
  return answer.replace(
    /`?\b([a-z][a-z0-9]*_[a-z0-9_]+)\b`?/g,
    (match, name: string) => (toolNames.has(name) ? "архива" : match),
  );
}

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
    .replace(
      /```(xychart(?:-beta)?|pie|graph|flowchart)\s*\r?\n([\s\S]*?)```/giu,
      (_block, kind: string, body: string) => {
        const source = body.trim();
        const head = /^(?:xychart(?:-beta)?|pie|graph|flowchart)\b/iu.test(
          source,
        )
          ? source
          : /^(?:graph|flowchart)$/iu.test(kind) &&
              /^(?:TD|TB|LR|RL|BT)\b/iu.test(source)
            ? `${kind.toLowerCase()} ${source}`
            : `${kind.toLowerCase()}\n${source}`;
        return `\x60\x60\x60mermaid\n${head}\n\x60\x60\x60`;
      },
    )
    // Match complete fenced blocks: an empty-block regex must not consume
    // the closing fence of one graph and the opening fence of the next.
    .replace(/^```([^\r\n]*)\r?\n([\s\S]*?)^```[ \t]*(?=\r?$)/gm,
      (block, language: string, body: string) =>
        (!language.trim() || /^mermaid$/iu.test(language.trim())) && !body.trim()
          ? "" : block)
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
  // Models sometimes escape Markdown delimiters around an otherwise valid
  // archive link. ReactMarkdown then displays the entire link as plain text.
  // Repair only Drevo URLs, leaving code samples and external URLs untouched.
  const normalizedContent = content
    .split(/(```[\s\S]*?```|`[^`\n]*`)/g)
    .map((part, index) =>
      index % 2
        ? part
        : part.replace(
            /\\?\[([^\]\n]+?)\\?\]\\?\(\\?(#drevo-(?:person|choose-person|photo)-[A-Za-z0-9%._~-]+)\\?\)/g,
            (_match, label: string, href: string) => markdownLink(label, href),
          ),
    )
    .join("");
  const placeholders: string[] = [];
  const reserve = (markdown: string) => {
    const token = `DREVOREF${placeholders.length}TOKEN`;
    placeholders.push(markdown);
    return token;
  };

  let value = outsideCodeFences(
    normalizeExternalResearchLinks(normalizedContent),
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
          : reference.kind === "web"
            ? reference.url
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
