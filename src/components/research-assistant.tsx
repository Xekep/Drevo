import { useEffect, useRef, useState } from "react";
import { Send, Sparkles, X } from "lucide-react";

type Message = { role: "user" | "assistant"; content: string };

export function ResearchAssistant({
  view,
  personIds,
}: {
  view: string;
  personIds: string[];
}) {
  const [enabled, setEnabled] = useState(false),
    [open, setOpen] = useState(false),
    [draft, setDraft] = useState(""),
    [messages, setMessages] = useState<Message[]>([]),
    [busy, setBusy] = useState(false),
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

  useEffect(() => {
    if (open) end.current?.scrollIntoView({ block: "end" });
  }, [open, messages, busy]);

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
    } catch (reason) {
      setError((reason as Error).message);
    } finally {
      setBusy(false);
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
                <small>Анализирует данные древа, не изменяя архив</small>
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
            {!messages.length && (
              <div className="research-assistant-empty">
                <p>
                  Спросите о пробелах, противоречиях, источниках или родственной
                  ветке.
                </p>
                <button onClick={() => void send("Что в этой ветке стоит проверить в первую очередь?")}>
                  Что проверить?
                </button>
                <button onClick={() => void send("Найди противоречия и возможные дубли в архиве.")}>
                  Проверить данные
                </button>
                <button onClick={() => void send("Какие сведения в архиве заполнены хуже всего?")}>
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
