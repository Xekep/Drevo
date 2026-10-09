import { Component, memo, useMemo, type ReactNode } from "react";
import type { ResearchAttachment } from "../../shared/research-attachments.ts";
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
  researchInternalLink,
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
  attachments?: ResearchAttachment[];
};

class AnswerBoundary extends Component<
  { content: string; children: ReactNode },
  { failed: boolean }
> {
  state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  componentDidUpdate(previous: { content: string }) {
    if (this.state.failed && previous.content !== this.props.content)
      this.setState({ failed: false });
  }
  render() {
    return this.state.failed ? (
      <p className="research-answer-fallback">{this.props.content}</p>
    ) : (
      this.props.children
    );
  }
}

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
        const link = researchInternalLink(href);
        if (!link && href.startsWith("#drevo-")) return <span>{children}</span>;
        if (!link)
          return (
            <a href={href} target="_blank" rel="noreferrer">
              {children}
            </a>
          );
        const { id, kind } = link,
          label = String(children);
        return (
          <button
            type="button"
            className="research-inline-reference"
            onClick={() =>
              kind === "photo"
                ? onPhoto(id)
                : kind === "choose-person"
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
    <AnswerBoundary content={message.content}>
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
    </AnswerBoundary>
  );
});

export default MarkdownAnswer;
