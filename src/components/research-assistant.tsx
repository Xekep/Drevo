import { useCallback, useEffect, useRef, useState } from "react";
import { BookOpen, Check, ExternalLink, Send, Sparkles, UserRound, X } from "lucide-react";

type AnswerReference =
  | { kind: "person"; id: string; label: string }
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
};
type SuggestionValue = string | boolean | undefined;
type SuggestionBase = {
  id: string;
  personName: string;
  reason: string;
  evidence: string[];
};
type ResearchSuggestion =
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

export function ResearchAssistant({
  view,
  personIds,
  canEdit,
  onChanged,
  onPerson,
}: {
  view: string;
  personIds: string[];
  canEdit: boolean;
  onChanged: () => void;
  onPerson: (id: string) => void;
}) {
  const [enabled, setEnabled] = useState(false),
    [open, setOpen] = useState(false),
    [draft, setDraft] = useState(""),
    [branchDepth, setBranchDepth] = useState(4),
    [messages, setMessages] = useState<Message[]>([]),
    [suggestions, setSuggestions] = useState<ResearchSuggestion[]>([]),
    [busy, setBusy] = useState(false),
    [reviewBusy, setReviewBusy] = useState(""),
    [streamStatus, setStreamStatus] = useState(""),
    [error, setError] = useState("");
  const end = useRef<HTMLDivElement>(null);

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
          }));
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
      if (action === "accept") onChanged();
    } catch (reason) {
      setError((reason as Error).message);
    } finally {
      setReviewBusy("");
    }
  }

  return (
    <>
      <button
        type="button"
        className="research-assistant-trigger"
        aria-expanded={open}
        aria-label="Открыть ИИ-исследователя"
        onClick={() => void openAssistant()}
      >
        <Sparkles size={18} />
        ИИ-исследователь
      </button>
      {open && (
        <aside className="research-assistant" aria-label="ИИ-исследователь">
          <header>
            <div>
              <Sparkles size={19} />
              <span>
                <b>ИИ-исследователь</b>
                <small>
                  Анализирует архив; изменения применяются только после
                  подтверждения
                </small>
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
                <h3>Предложения для проверки</h3>
                {suggestions.map((suggestion) => (
                  <div className="research-suggestion" key={suggestion.id}>
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
                    <footer>
                      <button
                        type="button"
                        className="primary-action"
                        disabled={!!reviewBusy}
                        onClick={() => void review(suggestion.id, "accept")}
                      >
                        <Check size={15} />
                        Принять
                      </button>
                      <button
                        type="button"
                        disabled={!!reviewBusy}
                        onClick={() => void review(suggestion.id, "reject")}
                      >
                        <X size={15} />
                        Отклонить
                      </button>
                    </footer>
                  </div>
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
                <p>{message.content}</p>
                {message.role === "assistant" &&
                  message.references &&
                  message.references.length > 0 && (
                    <div
                      className="research-answer-references"
                      aria-label="Связанные записи архива"
                    >
                      {message.references.map((reference, referenceIndex) =>
                        reference.kind === "person" ? (
                          <button
                            type="button"
                            key={`person:${reference.id}`}
                            onClick={() => {
                              setOpen(false);
                              onPerson(reference.id);
                            }}
                          >
                            <UserRound size={13} />
                            {reference.label}
                          </button>
                        ) : reference.url ? (
                          <a
                            key={`source:${reference.personId}:${referenceIndex}`}
                            href={reference.url}
                            target="_blank"
                            rel="noreferrer"
                            title={reference.reference || reference.label}
                          >
                            <BookOpen size={13} />
                            {reference.label}
                            <ExternalLink size={11} />
                          </a>
                        ) : (
                          <button
                            type="button"
                            key={`source:${reference.personId}:${referenceIndex}`}
                            title={reference.reference || reference.label}
                            onClick={() => {
                              setOpen(false);
                              onPerson(reference.personId);
                            }}
                          >
                            <BookOpen size={13} />
                            {reference.label}
                          </button>
                        ),
                      )}
                    </div>
                  )}
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
