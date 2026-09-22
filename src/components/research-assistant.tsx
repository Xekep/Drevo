import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
} from "react";
import { Check, Send, Sparkles, X } from "lucide-react";
import ReactMarkdown, { defaultUrlTransform } from "react-markdown";
import remarkGfm from "remark-gfm";

type AnswerReference =
  | { kind: "person"; id: string; label: string }
  | { kind: "photo"; id: string; label: string }
  | {
      kind: "source";
      personId: string;
      label: string;
      reference?: string;
      url?: string;
    };
type Message = {
  role: "user" | "assistant";
  content: string;
  references?: AnswerReference[];
  suggestionIds?: string[];
};
type UiAction =
  | { type: "focus_people"; personIds: string[] }
  | { type: "open_person"; personId: string }
  | { type: "open_photo"; photoId: string };

type PanelPosition = { left: number; top: number };

let mermaidModule: Promise<(typeof import("mermaid"))["default"]> | undefined;

function MermaidDiagram({ source }: { source: string }) {
  const host = useRef<HTMLDivElement>(null);
  const [error, setError] = useState("");

  useEffect(() => {
    let active = true;
    mermaidModule ||= import("mermaid").then((module) => {
      module.default.initialize({
        startOnLoad: false,
        securityLevel: "strict",
        theme: "neutral",
        fontFamily: "inherit",
      });
      return module.default;
    });
    void mermaidModule
      .then((mermaid) =>
        mermaid.render(
          `drevo-ai-${crypto.randomUUID().replaceAll("-", "")}`,
          source,
        ),
      )
      .then(({ svg }) => {
        if (active && host.current) host.current.innerHTML = svg;
      })
      .catch(() => {
        if (active) setError("Не удалось построить схему");
      });
    return () => {
      active = false;
    };
  }, [source]);

  return error ? (
    <pre className="research-mermaid-error">{error}</pre>
  ) : (
    <div
      ref={host}
      className="research-mermaid"
      role="img"
      aria-label="Схема, построенная ИИ-исследователем"
    />
  );
}

function escapePattern(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function markdownAnswer(message: Message) {
  const placeholders: string[] = [];
  let value = message.content.replace(
    /\[\[(person|choose-person):([^|\]\s]+)\|([^\]]+)\]\]/g,
    (_whole, kind: string, id: string, label: string) => {
      const token = `DREVOREF${placeholders.length}TOKEN`;
      placeholders.push(
        `[${label.replaceAll("[", "\\[").replaceAll("]", "\\]")}](#drevo-${kind}-${encodeURIComponent(id)})`,
      );
      return token;
    },
  );
  const represented = new Set(
    [...value.matchAll(/#drevo-(?:person|choose-person)-([^\s)]+)/g)].map(
      (match) => decodeURIComponent(match[1]),
    ),
  );
  for (const reference of message.references || []) {
    if (reference.kind === "person" && represented.has(reference.id)) continue;
    const href =
      reference.kind === "person"
        ? `#drevo-person-${encodeURIComponent(reference.id)}`
        : reference.kind === "photo"
          ? `#drevo-photo-${encodeURIComponent(reference.id)}`
          : reference.url ||
            `#drevo-person-${encodeURIComponent(reference.personId)}`;
    const pattern = new RegExp(escapePattern(reference.label), "giu");
    value = value.replace(
      pattern,
      (label) => `[${label.replaceAll("[", "\\[").replaceAll("]", "\\]")}](${href})`,
    );
  }
  placeholders.forEach((markdown, index) => {
    value = value.replace(`DREVOREF${index}TOKEN`, markdown);
  });
  return value;
}

function MarkdownAnswer({
  message,
  onPerson,
  onChoosePerson,
  onPhoto,
}: {
  message: Message;
  onPerson: (id: string) => void;
  onChoosePerson: (id: string, label: string) => void;
  onPhoto: (id: string) => void;
}) {
  return (
    <div className="research-markdown">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        urlTransform={(url) =>
          url.startsWith("#drevo-") ? url : defaultUrlTransform(url)
        }
        components={{
          a: ({ href = "", children }) => {
            const match =
              /^#drevo-(person|choose-person|photo)-(.+)$/.exec(href);
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
            className === "language-mermaid" ? (
              <MermaidDiagram source={String(children).trim()} />
            ) : (
              <code className={className} {...props}>
                {children}
              </code>
            ),
        }}
      >
        {markdownAnswer(message)}
      </ReactMarkdown>
    </div>
  );
}
type SuggestionValue = string | boolean | undefined;
type SuggestionBase = {
  id: string;
  personName: string;
  reason: string;
  evidence: string[];
};
type ResearchSuggestion =
  | (SuggestionBase & {
      kind: "person_create";
      payload: {
        person: Record<string, SuggestionValue>;
      };
    })
  | (SuggestionBase & {
      kind: "person_update";
      payload: {
        before: Record<string, SuggestionValue>;
        changes: Record<string, Exclude<SuggestionValue, undefined>>;
      };
    })
  | (SuggestionBase & {
      kind: "source";
      payload: {
        source: {
          title: string;
          type: string;
          reference: string;
          url?: string;
          note?: string;
        };
      };
    })
  | (SuggestionBase & {
      kind: "relation";
      fromName: string;
      toName: string;
      payload: {
        relationType: string;
        note?: string;
      };
    });

const fieldLabels: Record<string, string> = {
  surname: "Фамилия",
  name: "Имя",
  patronymic: "Отчество",
  birth: "Дата рождения",
  death: "Дата смерти",
  deceased: "Умер",
  birthPlace: "Место рождения",
  deathPlace: "Место смерти",
  maidenName: "Фамилия при рождении",
  occupation: "Занятие",
  biography: "Биография",
  parentageComplete: "Все родители известны",
};

const relationLabels: Record<string, string> = {
  parent: "Родитель → ребёнок",
  spouse: "Супруги",
  adoptive_parent: "Приёмный родитель → ребёнок",
  step_parent: "Отчим / мачеха → ребёнок",
  godparent: "Крёстный родитель → крестник",
  nurse: "Кормилица → ребёнок",
  sworn_sibling: "Названые брат / сестра",
  guardian: "Опекун → подопечный",
};

function valueLabel(value: SuggestionValue) {
  if (value === undefined || value === "") return "не указано";
  if (typeof value === "boolean") return value ? "да" : "нет";
  return value;
}

function parseSseFrame(frame: string) {
  let event = "message";
  const data: string[] = [];
  for (const line of frame.split(/\r?\n/)) {
    if (line.startsWith("event:")) event = line.slice(6).trim();
    else if (line.startsWith("data:")) data.push(line.slice(5).trimStart());
  }
  return { event, data: data.join("\n") };
}

function SuggestionDetails({
  suggestion,
}: {
  suggestion: ResearchSuggestion;
}) {
  if (suggestion.kind === "person_create")
    return (
      <ul>
        {Object.entries(suggestion.payload.person)
          .filter(
            ([field, value]) =>
              [
                "surname",
                "name",
                "patronymic",
                "birth",
                "birthPlace",
                "occupation",
                "biography",
              ].includes(field) && value,
          )
          .map(([field, value]) => (
            <li key={field}>
              <b>{fieldLabels[field] || field}</b>
              <span>{valueLabel(value)}</span>
            </li>
          ))}
      </ul>
    );

  if (suggestion.kind === "person_update")
    return (
      <ul>
        {Object.entries(suggestion.payload.changes).map(([field, value]) => (
          <li key={field}>
            <b>{fieldLabels[field] || field}</b>
            <span>
              {valueLabel(suggestion.payload.before[field])}
              {" → "}
              {valueLabel(value)}
            </span>
          </li>
        ))}
      </ul>
    );

  if (suggestion.kind === "source") {
    const source = suggestion.payload.source;
    return (
      <ul>
        <li>
          <b>Источник для {suggestion.personName}</b>
          <span>{source.title}</span>
        </li>
        <li>
          <b>Тип / ссылка на запись</b>
          <span>
            {source.type} · {source.reference}
          </span>
        </li>
        {source.url && (
          <li>
            <b>URL</b>
            <span>{source.url}</span>
          </li>
        )}
        {source.note && (
          <li>
            <b>Примечание</b>
            <span>{source.note}</span>
          </li>
        )}
      </ul>
    );
  }

  return (
    <ul>
      <li>
        <b>{relationLabels[suggestion.payload.relationType] || "Связь"}</b>
        <span>
          {suggestion.fromName} → {suggestion.toName}
        </span>
      </li>
      {suggestion.payload.note && (
        <li>
          <b>Примечание</b>
          <span>{suggestion.payload.note}</span>
        </li>
      )}
    </ul>
  );
}

function SuggestionCard({
  suggestion,
  disabled,
  onReview,
}: {
  suggestion: ResearchSuggestion;
  disabled: boolean;
  onReview: (id: string, action: "accept" | "reject") => void;
}) {
  return (
    <div className="research-suggestion">
      <strong>
        {suggestion.kind === "relation"
          ? `${suggestion.fromName} ↔ ${suggestion.toName}`
          : suggestion.personName}
      </strong>
      <p>{suggestion.reason}</p>
      <SuggestionDetails suggestion={suggestion} />
      {suggestion.evidence.length > 0 && (
        <details>
          <summary>Основания</summary>
          <ul>
            {suggestion.evidence.map((item, index) => (
              <li key={index}>{item}</li>
            ))}
          </ul>
        </details>
      )}
      <footer aria-label="Подтвердить изменение">
        <button
          type="button"
          className="primary-action"
          disabled={disabled}
          aria-label="Принять предложение"
          title="Принять"
          onClick={() => onReview(suggestion.id, "accept")}
        >
          <Check size={17} />
        </button>
        <button
          type="button"
          disabled={disabled}
          aria-label="Отклонить предложение"
          title="Отклонить"
          onClick={() => onReview(suggestion.id, "reject")}
        >
          <X size={17} />
        </button>
      </footer>
    </div>
  );
}

export function ResearchAssistant({
  view,
  personIds,
  canEdit,
  onChanged,
  onPerson,
  onPhoto,
  onReveal,
}: {
  view: string;
  personIds: string[];
  canEdit: boolean;
  onChanged: () => void;
  onPerson: (id: string) => void;
  onPhoto: (id: string) => void;
  onReveal: (ids: string[]) => void;
}) {
  const [enabled, setEnabled] = useState(false),
    [open, setOpen] = useState(false),
    [draft, setDraft] = useState(""),
    [branchDepth, setBranchDepth] = useState(4),
    [messages, setMessages] = useState<Message[]>([]),
    [suggestions, setSuggestions] = useState<ResearchSuggestion[]>([]),
    [busy, setBusy] = useState(false),
    [reviewBusy, setReviewBusy] = useState(""),
    [reviewedSuggestions, setReviewedSuggestions] = useState<
      Record<string, "accepted" | "rejected">
    >({}),
    [streamStatus, setStreamStatus] = useState(""),
    [error, setError] = useState(""),
    [panelPosition, setPanelPosition] = useState<PanelPosition | null>(null);
  const end = useRef<HTMLDivElement>(null),
    panel = useRef<HTMLElement>(null),
    drag = useRef<{
      pointerId: number;
      offsetX: number;
      offsetY: number;
    } | null>(null);

  const clampPanelPosition = useCallback((left: number, top: number) => {
    const rect = panel.current?.getBoundingClientRect(),
      width = rect?.width || 430,
      height = rect?.height || 680,
      margin = 8;
    return {
      left: Math.min(Math.max(margin, left), Math.max(margin, innerWidth - width - margin)),
      top: Math.min(Math.max(margin, top), Math.max(margin, innerHeight - height - margin)),
    };
  }, []);

  useEffect(() => {
    const keepVisible = () =>
      setPanelPosition((current) =>
        current ? clampPanelPosition(current.left, current.top) : current,
      );
    window.addEventListener("resize", keepVisible);
    return () => window.removeEventListener("resize", keepVisible);
  }, [clampPanelPosition]);

  const startDrag = (event: ReactPointerEvent<HTMLElement>) => {
    if (
      event.button !== 0 ||
      innerWidth <= 600 ||
      (event.target as HTMLElement).closest("button, a, input, select, textarea")
    )
      return;
    const rect = panel.current?.getBoundingClientRect();
    if (!rect) return;
    drag.current = {
      pointerId: event.pointerId,
      offsetX: event.clientX - rect.left,
      offsetY: event.clientY - rect.top,
    };
    setPanelPosition({ left: rect.left, top: rect.top });
    event.currentTarget.setPointerCapture(event.pointerId);
  };

  const moveDrag = (event: ReactPointerEvent<HTMLElement>) => {
    const state = drag.current;
    if (!state || state.pointerId !== event.pointerId) return;
    setPanelPosition(
      clampPanelPosition(
        event.clientX - state.offsetX,
        event.clientY - state.offsetY,
      ),
    );
  };

  const stopDrag = (event: ReactPointerEvent<HTMLElement>) => {
    if (drag.current?.pointerId !== event.pointerId) return;
    drag.current = null;
    if (event.currentTarget.hasPointerCapture(event.pointerId))
      event.currentTarget.releasePointerCapture(event.pointerId);
  };

  useEffect(() => {
    const controller = new AbortController();
    void fetch("/api/ai/status", {
      cache: "no-store",
      signal: controller.signal,
    })
      .then(async (response) => {
        if (response.ok) setEnabled((await response.json()).enabled === true);
      })
      .catch(() => {});
    return () => controller.abort();
  }, []);

  const loadSuggestions = useCallback(async () => {
    if (!canEdit) return;
    const response = await fetch("/api/research/suggestions", {
        cache: "no-store",
      }),
      data = await response.json();
    if (!response.ok)
      throw new Error(data.error || "Не удалось загрузить предложения");
    setSuggestions(data.suggestions || []);
  }, [canEdit]);

  useEffect(() => {
    if (open) end.current?.scrollIntoView({ block: "end" });
  }, [open, messages, busy, suggestions]);

  if (!enabled) return null;

  async function openAssistant() {
    setOpen(true);
    setError("");
    if (!canEdit) return;
    try {
      await loadSuggestions();
    } catch (reason) {
      setError((reason as Error).message);
    }
  }

  async function send(text = draft) {
    const message = text.trim();
    if (!message || busy) return;
    const history = messages.slice(-10);
    setMessages((current) => [
      ...current,
      { role: "user", content: message },
      { role: "assistant", content: "", references: [] },
    ]);
    setDraft("");
    setBusy(true);
    setStreamStatus("Соединяюсь…");
    setError("");
    try {
      const response = await fetch("/api/ai/chat/stream", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          message,
          history,
          context: { view, personIds },
        }),
      });
      if (!response.ok) {
        const data = await response.json().catch(() => ({}));
        throw new Error(
          (data as { error?: string }).error ||
            "ИИ-исследователь не ответил",
        );
      }
      if (!response.body)
        throw new Error("Сервер не вернул поток ответа");

      const reader = response.body.getReader(),
        decoder = new TextDecoder();
      let buffer = "",
        finished = false;

      const updateAssistant = (
        updater: (message: Message) => Message,
      ) =>
        setMessages((current) => {
          const next = [...current],
            index = next.length - 1;
          if (index < 0 || next[index].role !== "assistant") return current;
          next[index] = updater(next[index]);
          return next;
        });

      const consume = (frame: string) => {
        const parsed = parseSseFrame(frame);
        if (!parsed.data) return;
        const data = JSON.parse(parsed.data) as {
          text?: string;
          message?: string;
          answer?: string;
          error?: string;
          references?: AnswerReference[];
          suggestionIds?: string[];
          uiActions?: UiAction[];
        };
        if (parsed.event === "status") {
          if (data.message) setStreamStatus(data.message);
          return;
        }
        if (parsed.event === "delta") {
          if (data.text)
            updateAssistant((item) => ({
              ...item,
              content: item.content + data.text,
            }));
          return;
        }
        if (parsed.event === "done") {
          finished = true;
          setStreamStatus("");
          updateAssistant((item) => ({
            ...item,
            content: data.answer || item.content,
            references: Array.isArray(data.references)
              ? data.references
              : item.references,
            suggestionIds: Array.isArray(data.suggestionIds)
              ? data.suggestionIds
              : item.suggestionIds,
          }));
          for (const action of data.uiActions || []) {
            setOpen(false);
            if (action.type === "focus_people") onReveal(action.personIds);
            else if (action.type === "open_person") onPerson(action.personId);
            else if (action.type === "open_photo") onPhoto(action.photoId);
          }
          return;
        }
        if (parsed.event === "error")
          throw new Error(data.error || "Ошибка потокового ответа ИИ");
      };

      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        while (true) {
          const match = /\r?\n\r?\n/.exec(buffer);
          if (!match || match.index === undefined) break;
          const frame = buffer.slice(0, match.index);
          buffer = buffer.slice(match.index + match[0].length);
          consume(frame);
        }
      }
      buffer += decoder.decode();
      if (buffer.trim()) consume(buffer);
      if (!finished)
        throw new Error("Поток ответа завершился раньше события done");

      if (canEdit) await loadSuggestions();
    } catch (reason) {
      setMessages((current) => {
        const last = current.at(-1);
        return last?.role === "assistant" && !last.content
          ? current.slice(0, -1)
          : current;
      });
      setError((reason as Error).message);
    } finally {
      setStreamStatus("");
      setBusy(false);
    }
  }

  async function review(id: string, action: "accept" | "reject") {
    if (reviewBusy) return;
    setReviewBusy(id);
    setError("");
    try {
      const response = await fetch(
          `/api/research/suggestions/${encodeURIComponent(id)}/${action}`,
          { method: "POST" },
        ),
        data = await response.json();
      if (!response.ok)
        throw new Error(data.error || "Не удалось обработать предложение");
      setSuggestions((current) =>
        current.filter((suggestion) => suggestion.id !== id),
      );
      setReviewedSuggestions((current) => ({
        ...current,
        [id]: action === "accept" ? "accepted" : "rejected",
      }));
      if (action === "accept") onChanged();
    } catch (reason) {
      setError((reason as Error).message);
    } finally {
      setReviewBusy("");
    }
  }

  return (
    <>
      {!open && (
        <button
          type="button"
          className="research-assistant-trigger"
          aria-expanded={false}
          aria-label="Открыть ИИ-исследователя"
          title="ИИ-исследователь"
          onClick={() => void openAssistant()}
        >
          <Sparkles size={19} />
        </button>
      )}
      {open && (
        <aside
          ref={panel}
          className="research-assistant"
          aria-label="ИИ-исследователь"
          style={
            panelPosition
              ? {
                  left: panelPosition.left,
                  top: panelPosition.top,
                  right: "auto",
                  bottom: "auto",
                }
              : undefined
          }
        >
          <header
            onPointerDown={startDrag}
            onPointerMove={moveDrag}
            onPointerUp={stopDrag}
            onPointerCancel={stopDrag}
            title="Перетащите окно"
          >
            <div>
              <Sparkles size={19} />
              <span>
                <b>ИИ-исследователь</b>
              </span>
            </div>
            <button
              type="button"
              aria-label="Закрыть ИИ-исследователя"
              onClick={() => setOpen(false)}
            >
              <X size={18} />
            </button>
          </header>
          <div className="research-assistant-messages">
            {canEdit && suggestions.length > 0 && (
              <section
                className="research-suggestions"
                aria-label="Предложения ИИ"
              >
                {suggestions
                  .filter(
                    (suggestion) =>
                      !messages.some((message) =>
                        message.suggestionIds?.includes(suggestion.id),
                      ),
                  )
                  .map((suggestion) => (
                    <SuggestionCard
                      key={suggestion.id}
                      suggestion={suggestion}
                      disabled={!!reviewBusy}
                      onReview={(id, action) => void review(id, action)}
                    />
                  ))}
              </section>
            )}
            {!messages.length && (
              <div className="research-assistant-empty">
                <p>
                  Спросите о пробелах, противоречиях, источниках или родственной
                  ветке.
                </p>
                {personIds[0] && (
                  <div className="research-branch-action">
                    <label>
                      Ветка предков
                      <select
                        value={branchDepth}
                        disabled={busy}
                        onChange={(event) =>
                          setBranchDepth(Number(event.target.value))
                        }
                      >
                        <option value={2}>2 поколения</option>
                        <option value={4}>4 поколения</option>
                        <option value={6}>6 поколений</option>
                        <option value={8}>8 поколений</option>
                      </select>
                    </label>
                    <button
                      onClick={() =>
                        void send(
                          `Проанализируй ветку предков выбранного человека на глубину ${branchDepth} поколений. Сначала вызови get_branch_insights с direction=ancestors и depth=${branchDepth}. Отдельно покажи подтверждённые пробелы, вычисляемые предупреждения и что искать дальше.`,
                        )
                      }
                    >
                      Анализировать ветку
                    </button>
                  </div>
                )}
                {personIds[0] && (
                  <button
                    onClick={() =>
                      void send(
                        `Составь план дальнейшего генеалогического поиска по выбранному человеку. Сначала вызови get_research_backlog с personId=${personIds[0]}, direction=ancestors, depth=${branchDepth}, limit=10. Покажи первые шаги по приоритету: какой документ искать, какие пробелы он может закрыть и какие уже известные ориентиры использовать. Не выдавай отсутствие записи за отсутствие события.`,
                      )
                    }
                  >
                    План поиска
                  </button>
                )}
                <button
                  onClick={() =>
                    void send("Что в этой ветке стоит проверить в первую очередь?")
                  }
                >
                  Что проверить?
                </button>
                <button
                  onClick={() =>
                    void send(
                      "Проверь качество данных. Сначала вызови find_inconsistencies, затем find_possible_duplicates. Покажи противоречия отдельно от вероятных дублей: дубль — только гипотеза для ручной проверки.",
                    )
                  }
                >
                  Проверить данные
                </button>
                <button
                  onClick={() =>
                    void send("Какие сведения в архиве заполнены хуже всего?")
                  }
                >
                  Найти пробелы
                </button>
              </div>
            )}
            {messages.map((message, index) => (
              <article key={index} className={`is-${message.role}`}>
                <small>{message.role === "user" ? "Вы" : "Drevo AI"}</small>
                {message.role === "assistant" ? (
                  <MarkdownAnswer
                    message={message}
                    onPerson={(id) => {
                      setOpen(false);
                      onPerson(id);
                    }}
                    onChoosePerson={(id, label) =>
                      void send(
                        `Выбран человек: ${label} (personId: ${id}). Продолжи мой предыдущий запрос для этого человека.`,
                      )
                    }
                    onPhoto={(id) => {
                      setOpen(false);
                      onPhoto(id);
                    }}
                  />
                ) : (
                  <p>{message.content}</p>
                )}
                {message.role === "assistant" &&
                  message.suggestionIds?.map((id) => {
                    const suggestion = suggestions.find(
                      (item) => item.id === id,
                    );
                    return suggestion ? (
                      <SuggestionCard
                        key={id}
                        suggestion={suggestion}
                        disabled={!!reviewBusy}
                        onReview={(suggestionId, action) =>
                          void review(suggestionId, action)
                        }
                      />
                    ) : reviewedSuggestions[id] ? (
                      <p className="research-suggestion-result" key={id}>
                        {reviewedSuggestions[id] === "accepted"
                          ? "✓ Изменение применено"
                          : "× Предложение отклонено"}
                      </p>
                    ) : null;
                  })}
              </article>
            ))}
            {busy && (
              <p role="status">
                {streamStatus || "ИИ формирует ответ…"}
              </p>
            )}
            {error && (
              <p className="form-error" role="alert">
                {error}
              </p>
            )}
            <div ref={end} />
          </div>
          <form
            onSubmit={(event) => {
              event.preventDefault();
              void send();
            }}
          >
            <textarea
              value={draft}
              rows={3}
              maxLength={8000}
              placeholder="Например: что искать дальше по выбранному человеку?"
              onChange={(event) => setDraft(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter" && !event.shiftKey) {
                  event.preventDefault();
                  void send();
                }
              }}
            />
            <button
              type="submit"
              className="primary-action"
              disabled={busy || !draft.trim()}
              aria-label="Отправить запрос"
            >
              <Send size={17} />
            </button>
          </form>
        </aside>
      )}
    </>
  );
}
