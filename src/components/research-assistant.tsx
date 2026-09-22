import { useCallback, useEffect, useRef, useState } from "react";
import { Check, Send, Sparkles, X } from "lucide-react";

type Message = { role: "user" | "assistant"; content: string };
type SuggestionValue = string | boolean | undefined;
type ResearchSuggestion = {
  id: string;
  personName: string;
  reason: string;
  evidence: string[];
  payload: {
    before: Record<string, SuggestionValue>;
    changes: Record<string, Exclude<SuggestionValue, undefined>>;
  };
};

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

function valueLabel(value: SuggestionValue) {
  if (value === undefined || value === "") return "не указано";
  if (typeof value === "boolean") return value ? "да" : "нет";
  return value;
}

export function ResearchAssistant({
  view,
  personIds,
  canEdit,
  onChanged,
}: {
  view: string;
  personIds: string[];
  canEdit: boolean;
  onChanged: () => void;
}) {
  const [enabled, setEnabled] = useState(false),
    [open, setOpen] = useState(false),
    [draft, setDraft] = useState(""),
    [branchDepth, setBranchDepth] = useState(4),
    [messages, setMessages] = useState<Message[]>([]),
    [suggestions, setSuggestions] = useState<ResearchSuggestion[]>([]),
    [busy, setBusy] = useState(false),
    [reviewBusy, setReviewBusy] = useState(""),
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
    if (!open || !canEdit) return;
    void loadSuggestions().catch((reason) =>
      setError((reason as Error).message),
    );
  }, [open, canEdit, loadSuggestions]);

  useEffect(() => {
    if (open) end.current?.scrollIntoView({ block: "end" });
  }, [open, messages, busy, suggestions]);

  if (!enabled) return null;

  async function send(text = draft) {
    const message = text.trim();
    if (!message || busy) return;
    const history = messages.slice(-10);
    setMessages((current) => [...current, { role: "user", content: message }]);
    setDraft("");
    setBusy(true);
    setError("");
    try {
      const response = await fetch("/api/ai/chat", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            message,
            history,
            context: { view, personIds },
          }),
        }),
        data = await response.json();
      if (!response.ok)
        throw new Error(data.error || "ИИ-исследователь не ответил");
      setMessages((current) => [
        ...current,
        { role: "assistant", content: data.answer },
      ]);
      if (canEdit) await loadSuggestions();
    } catch (reason) {
      setError((reason as Error).message);
    } finally {
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
        onClick={() => setOpen(true)}
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
                    <strong>{suggestion.personName}</strong>
                    <p>{suggestion.reason}</p>
                    <ul>
                      {Object.entries(suggestion.payload.changes).map(
                        ([field, value]) => (
                          <li key={field}>
                            <b>{fieldLabels[field] || field}</b>
                            <span>
                              {valueLabel(suggestion.payload.before[field])}
                              {" → "}
                              {valueLabel(value)}
                            </span>
                          </li>
                        ),
                      )}
                    </ul>
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
                <button
                  onClick={() =>
                    void send("Что в этой ветке стоит проверить в первую очередь?")
                  }
                >
                  Что проверить?
                </button>
                <button
                  onClick={() =>
                    void send("Найди противоречия и возможные дубли в архиве.")
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
              </article>
            ))}
            {busy && <p role="status">Исследую данные…</p>}
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
