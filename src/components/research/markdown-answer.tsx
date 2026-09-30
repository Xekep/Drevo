import { memo, useMemo } from "react";
import ReactMarkdown, {
  defaultUrlTransform,
  type Components,
} from "react-markdown";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import rehypeKatex from "rehype-katex";
import "katex/dist/katex.min.css";
import { ResearchVisualChart } from "../charts/research-visual-chart";
import {
  linkResearchReferences,
  normalizeResearchMarkdown,
  type ResearchAnswerReference,
} from "../../domain/research-answer.ts";
import { normalizeResearchMath } from "../../domain/research-math.ts";
import { archiveResourceUrl } from "../../domain/archive-context.ts";

export type ResearchMessage = {
  role: "user" | "assistant";
  content: string;
  references?: ResearchAnswerReference[];
  suggestionIds?: string[];
  files?: Array<{ name: string; url: string }>;
  activities?: string[];
};

const MarkdownAnswer = memo(function MarkdownAnswer({
  message,
  onPerson,
  onChoosePerson,
  onPhoto,
}: {
  message: ResearchMessage;
  onPerson: (id: string) => void;
  onChoosePerson: (id: string, label: string) => void;
  onPhoto: (id: string) => void;
}) {
  const components = useMemo<Components>(
    () => ({
      a: ({ href = "", children }) => {
        const match = /^#drevo-(person|choose-person|photo)-(.+)$/.exec(href);
        if (!match)
          return (
            <a href={href} target="_blank" rel="noreferrer">
              {children}
            </a>
          );
        const id = decodeURIComponent(match[2]),
          label = String(children);
        return (
          <button
            type="button"
            className="research-inline-reference"
            onClick={() =>
              match[1] === "photo"
                ? onPhoto(id)
                : match[1] === "choose-person"
                  ? onChoosePerson(id, label)
                  : onPerson(id)
            }
          >
            {children}
          </button>
        );
      },
      code: ({ className, children, ...props }) =>
        className === "language-mermaid" &&
        !String(children).trim() ? null : className === "language-mermaid" ? (
          <ResearchVisualChart source={String(children).trim()} />
        ) : (
          <code className={className} {...props}>
            {children}
          </code>
        ),
    }),
    [onChoosePerson, onPerson, onPhoto],
  );
  return (
    <div className="research-markdown">
      <ReactMarkdown
        remarkPlugins={[remarkGfm, remarkMath]}
        rehypePlugins={[[rehypeKatex, { trust: false }]]}
        urlTransform={(url) =>
          url.startsWith("#drevo-")
            ? url
            : archiveResourceUrl(defaultUrlTransform(url))
        }
        components={components}
      >
        {normalizeResearchMath(
          linkResearchReferences(
            message.role === "assistant"
              ? normalizeResearchMarkdown(message.content)
              : message.content,
            message.references,
          ),
        )}
      </ReactMarkdown>
      {message.references?.some((reference) => reference.kind === "web") && (
        <details>
          <summary>Найденные веб-источники</summary>
          <ul>
            {message.references
              .filter((reference) => reference.kind === "web")
              .map((reference) => (
                <li key={reference.url}>
                  <a
                    href={reference.url}
                    target="_blank"
                    rel="noopener noreferrer"
                  >
                    {reference.label}
                  </a>
                  {" · "}
                  {reference.sourceName || reference.domain}
                  {reference.snippet && <p>{reference.snippet}</p>}
                </li>
              ))}
          </ul>
          <small>Результат поиска требует проверки исходной страницы.</small>
        </details>
      )}
    </div>
  );
});

export default MarkdownAnswer;
