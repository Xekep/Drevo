import type { ResearchResult, UiAction } from "../shared/research-protocol.ts";
import { browserTimeZone } from "../data/browser-time-zone";
import {
  useResearchPanel,
  RESIZE_DIRECTIONS,
} from "./research/use-research-panel";
import {
  memo,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  Check,
  ChevronDown,
  LoaderCircle,
  Send,
  Sparkles,
  Square,
  Trash2,
  X,
} from "lucide-react";
import { ResearchVisualChart } from "./charts/research-visual-chart";
import ReactMarkdown, {
  defaultUrlTransform,
  type Components,
} from "react-markdown";
import remarkGfm from "remark-gfm";
import {
  linkResearchReferences,
  normalizeResearchMarkdown,
  type ResearchAnswerReference,
} from "../domain/research-answer.ts";

type AnswerReference = ResearchAnswerReference;
type Message = {
  role: "user" | "assistant";
  content: string;
  references?: AnswerReference[];
  suggestionIds?: string[];
  files?: Array<{ name: string; url: string }>;
  activities?: string[];
};
type LauncherPosition = { left: number; top: number };

const MarkdownAnswer = memo(function MarkdownAnswer({
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
        remarkPlugins={[remarkGfm]}
        urlTransform={(url) =>
          url.startsWith("#drevo-") ? url : defaultUrlTransform(url)
        }
        components={components}
      >
        {linkResearchReferences(
          message.role === "assistant"
            ? normalizeResearchMarkdown(message.content)
            : message.content,
          message.references,
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
type SuggestionValue = string | boolean | undefined;
type SuggestionBase = {
  id: string;
  personId: string;
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

function SuggestionDetails({ suggestion }: { suggestion: ResearchSuggestion }) {
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
          className="research-suggestion-accept"
          disabled={disabled}
          aria-label={`Принять изменение: ${suggestion.personName}`}
          onClick={() => onReview(suggestion.id, "accept")}
        >
          <Check size={17} aria-hidden="true" /> Принять
        </button>
        <button
          type="button"
          className="research-suggestion-reject"
          disabled={disabled}
          aria-label={`Отклонить изменение: ${suggestion.personName}`}
          onClick={() => onReview(suggestion.id, "reject")}
        >
          <X size={17} aria-hidden="true" /> Отклонить
        </button>
      </footer>
    </div>
  );
}

export function ResearchAssistant({
  view,
  onOpenChange,
  personIds,
  openPersonId,
  openPhotoId,
  currentPersonName,
  nudgeToken = 0,
  canEdit,
  onChanged,
  onPerson,
  onPhoto,
  onReveal,
  onFilter,
  onZoom,
}: {
  view: string;
  onOpenChange?: (open: boolean) => void;
  personIds: string[];
  openPersonId?: string;
  openPhotoId?: string;
  currentPersonName?: string;
  nudgeToken?: number;
  canEdit: boolean;
  onChanged: (createdPersonId?: string) => void;
  onPerson: (id: string) => void;
  onPhoto: (id: string) => void;
  onReveal: (ids: string[]) => void;
  onFilter: (ids: string[], label: string) => void;
  onZoom: (direction: "in" | "out") => void;
}) {
  const [enabled, setEnabled] = useState(false),
    [open, setOpen] = useState(false),
    [draft, setDraft] = useState(""),
    [messages, setMessages] = useState<Message[]>([]),
    [chatId, setChatId] = useState(""),
    [chats, setChats] = useState<
      Array<{ id: string; title: string; updatedAt: string }>
    >([]),
    [chatMenuOpen, setChatMenuOpen] = useState(false),
    [chatSearch, setChatSearch] = useState(""),
    [chatLoading, setChatLoading] = useState(true),
    [serverBusyChats, setServerBusyChats] = useState<Record<string, boolean>>(
      {},
    ),
    [suggestions, setSuggestions] = useState<ResearchSuggestion[]>([]),
    [workingChats, setWorkingChats] = useState<
      Record<string, { status: string; activities: string[] }>
    >({}),
    [reviewBusy, setReviewBusy] = useState(""),
    [reviewedSuggestions, setReviewedSuggestions] = useState<
      Record<
        string,
        {
          status: "accepted" | "rejected";
          kind: ResearchSuggestion["kind"];
          personName: string;
        }
      >
    >({}),
    [error, setError] = useState(""),
    [launcherPosition, setLauncherPosition] = useState<LauncherPosition | null>(
      null,
    ),
    [nudgeVisible, setNudgeVisible] = useState(false);
  const end = useRef<HTMLDivElement>(null),
    composer = useRef<HTMLTextAreaElement>(null),
    chatPicker = useRef<HTMLDivElement>(null),
    chatPickerTrigger = useRef<HTMLButtonElement>(null),
    lastNudge = useRef(0),
    chatSelection = useRef(0),
    selectedChatKey = useRef("new:initial"),
    activeRequests = useRef(new Map<string, AbortController>()),
    chatMessages = useRef(new Map<string, Message[]>()),
    chatErrors = useRef(new Map<string, string>()),
    pendingUiActions = useRef(new Map<string, UiAction[]>()),
    sendLatest = useRef<
      (text?: string, selectedPersonId?: string) => Promise<void>
    >(() => Promise.resolve());
  const {
    panel,
    panelPosition,
    startDrag,
    moveDrag,
    stopDrag,
    startResize,
    moveResize,
    stopResize,
    resizeWithKeyboard,
  } = useResearchPanel(open);
  const currentWork = workingChats[selectedChatKey.current],
    busy = !!currentWork || !!serverBusyChats[chatId],
    streamStatus =
      currentWork?.status ||
      (serverBusyChats[chatId]
        ? "Ответ ещё выполняется на сервере. Его можно остановить."
        : ""),
    activities = currentWork?.activities || [];

  useLayoutEffect(() => {
    const field = composer.current;
    if (!field) return;
    field.style.height = "auto";
    field.style.height = `${Math.min(field.scrollHeight, 150)}px`;
  }, [draft, open]);

  useEffect(() => {
    onOpenChange?.(open);
    return () => onOpenChange?.(false);
  }, [onOpenChange, open]);

  useEffect(
    () => () => {
      for (const controller of activeRequests.current.values())
        controller.abort();
      activeRequests.current.clear();
    },
    [],
  );

  useEffect(() => {
    if (!chatMenuOpen) return;
    const closeOutside = (event: PointerEvent) => {
      if (!chatPicker.current?.contains(event.target as Node))
        setChatMenuOpen(false);
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      setChatMenuOpen(false);
      chatPickerTrigger.current?.focus();
    };
    document.addEventListener("pointerdown", closeOutside);
    document.addEventListener("keydown", closeOnEscape);
    return () => {
      document.removeEventListener("pointerdown", closeOutside);
      document.removeEventListener("keydown", closeOnEscape);
    };
  }, [chatMenuOpen]);

  useEffect(() => {
    if (!enabled) return;
    let active = true;
    const selection = chatSelection.current;
    void fetch("/api/ai/chats", { credentials: "same-origin" })
      .then(async (response) => {
        if (!response.ok) throw new Error("Не удалось загрузить диалоги");
        return (await response.json()) as { chats: typeof chats };
      })
      .then(async (data) => {
        if (!active) return;
        setChats(data.chats);
        if (data.chats[0]) {
          const response = await fetch(`/api/ai/chats/${data.chats[0].id}`);
          if (!response.ok) return;
          const detail = (await response.json()) as { messages: Message[] };
          if (active && selection === chatSelection.current) {
            selectedChatKey.current = data.chats[0].id;
            chatMessages.current.set(data.chats[0].id, detail.messages);
            setChatId(data.chats[0].id);
            setMessages(detail.messages);
          }
        }
      })
      .catch(() => {
        if (active) setError("Не удалось загрузить историю диалогов");
      })
      .finally(() => {
        if (active && selection === chatSelection.current)
          setChatLoading(false);
      });
    return () => {
      active = false;
    };
  }, [enabled]);

  useEffect(() => {
    if (!open || !chatId) return;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    let wasBusy = false;
    const refresh = async () => {
      try {
        if (!activeRequests.current.has(chatId)) {
          const response = await fetch(`/api/ai/chats/${chatId}`, {
            signal: controller.signal,
            cache: "no-store",
          });
          if (response.ok) {
            const data = (await response.json()) as {
              chat: { busy?: boolean };
              messages: Message[];
            };
            if (
              controller.signal.aborted ||
              selectedChatKey.current !== chatId ||
              activeRequests.current.has(chatId)
            )
              return;
            const running = data.chat?.busy === true;
            setServerBusyChats((current) =>
              current[chatId] === running
                ? current
                : { ...current, [chatId]: running },
            );
            if (
              running ||
              wasBusy ||
              data.messages.length >
                (chatMessages.current.get(chatId)?.length || 0)
            ) {
              chatMessages.current.set(chatId, data.messages);
              setMessages(data.messages);
            }
            if (
              !running &&
              wasBusy &&
              data.messages.at(-1)?.role === "assistant"
            ) {
              chatErrors.current.delete(chatId);
              setError("");
            }
            wasBusy = running;
          }
        }
      } catch {
        /* Keep the last known state during a temporary disconnect. */
      } finally {
        if (!controller.signal.aborted)
          timer = setTimeout(() => void refresh(), 2000);
      }
    };
    void refresh();
    return () => {
      controller.abort();
      clearTimeout(timer);
    };
  }, [open, chatId]);

  useEffect(() => {
    if (view !== "tree") return;
    let frame = 0;
    let observedControls: HTMLElement | null = null;
    const observer = new ResizeObserver(() => update()),
      mutations = new MutationObserver(() => update()),
      update = () => {
        const canvas = document.querySelector<HTMLElement>(".tree-canvas");
        if (!canvas) return;
        const controls = [
          ...canvas.querySelectorAll<HTMLElement>(
            ".flow-camera-tools, .flow-fullscreen-tools",
          ),
        ].find((item) => item.getBoundingClientRect().width > 0);
        if (observedControls !== controls) {
          if (observedControls) observer.unobserve(observedControls);
          if (controls) observer.observe(controls);
          observedControls = controls || null;
        }
        const rect = controls?.getBoundingClientRect(),
          canvasRect = canvas.getBoundingClientRect(),
          next = rect
            ? {
                left: Math.max(8, rect.left - 50),
                top: Math.max(8, rect.bottom - 42),
              }
            : {
                left: Math.max(8, canvasRect.right - 62),
                top: Math.max(8, canvasRect.bottom - 62),
              };
        setLauncherPosition((current) =>
          current?.left === next.left && current.top === next.top
            ? current
            : next,
        );
      },
      attach = () => {
        const canvas = document.querySelector<HTMLElement>(".tree-canvas");
        if (canvas) {
          observer.observe(canvas);
          mutations.observe(canvas, { childList: true });
        }
        update();
      };
    frame = requestAnimationFrame(attach);
    const retry = window.setTimeout(attach, 160);
    window.addEventListener("resize", update);
    return () => {
      cancelAnimationFrame(frame);
      window.clearTimeout(retry);
      window.removeEventListener("resize", update);
      observer.disconnect();
      mutations.disconnect();
    };
  }, [view]);

  useEffect(() => {
    if (open || !nudgeToken || nudgeToken === lastNudge.current) return;
    lastNudge.current = nudgeToken;
    const reveal = window.setTimeout(() => setNudgeVisible(true), 0),
      hide = window.setTimeout(() => setNudgeVisible(false), 3_600);
    return () => {
      window.clearTimeout(reveal);
      window.clearTimeout(hide);
    };
  }, [nudgeToken, open]);

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

  useEffect(() => {
    sendLatest.current = send;
  });
  const choosePerson = useCallback((id: string) => {
    void sendLatest.current("", id);
  }, []);

  if (!enabled) return null;

  async function openAssistant() {
    setNudgeVisible(false);
    setOpen(true);
    setError("");
    if (!canEdit) return;
    try {
      await loadSuggestions();
    } catch (reason) {
      setError((reason as Error).message);
    }
  }

  async function stopGeneration() {
    const key = selectedChatKey.current;
    const controller = activeRequests.current.get(key);
    controller?.abort();
    activeRequests.current.delete(key);
    setWorkingChats((current) => {
      const next = { ...current };
      delete next[key];
      return next;
    });
    if (key.startsWith("new:")) return;
    try {
      const response = await fetch(`/api/ai/chats/${key}/stop`, {
        method: "POST",
      });
      const data = await response.json();
      if (!response.ok)
        throw new Error(data.error || "Не удалось остановить ответ");
      setServerBusyChats((current) => ({
        ...current,
        [key]: data.busy === true,
      }));
      if (selectedChatKey.current === key) setError("");
    } catch (reason) {
      if (selectedChatKey.current === key) setError((reason as Error).message);
    }
  }

  function applyUiActions(actions: UiAction[]) {
    for (const action of actions) {
      if (action.type === "focus_people") onReveal(action.personIds);
      else if (action.type === "filter_people")
        onFilter(action.personIds, action.label);
      else if (action.type === "open_person") onPerson(action.personId);
      else if (action.type === "open_photo") onPhoto(action.photoId);
      else if (action.type === "zoom_in") onZoom("in");
      else if (action.type === "zoom_out") onZoom("out");
    }
  }

  async function openChat(id: string) {
    setChatMenuOpen(false);
    setChatSearch("");
    if (id && id === selectedChatKey.current) return;
    const selection = ++chatSelection.current;
    if (!id) {
      selectedChatKey.current = `new:${crypto.randomUUID()}`;
      chatMessages.current.set(selectedChatKey.current, []);
      setChatId("");
      setMessages([]);
      setError("");
      setChatLoading(false);
      return;
    }
    const previousId = chatId;
    const previousKey = selectedChatKey.current;
    const previousMessages = messages;
    selectedChatKey.current = id;
    setChatId(id);
    setChatLoading(true);
    const cached = chatMessages.current.get(id);
    setMessages(cached || []);
    setError(chatErrors.current.get(id) || "");
    try {
      const response = await fetch(`/api/ai/chats/${id}`);
      if (!response.ok) throw new Error("Не удалось открыть диалог");
      const data = (await response.json()) as { messages: Message[] };
      if (selection !== chatSelection.current) return;
      // A running response can finish while the history request is in flight.
      const latest = chatMessages.current.get(id);
      const next =
        latest && latest.length > data.messages.length ? latest : data.messages;
      chatMessages.current.set(id, next);
      setMessages(next);
      setError(chatErrors.current.get(id) || "");
      const actions = pendingUiActions.current.get(id);
      if (actions) {
        pendingUiActions.current.delete(id);
        applyUiActions(actions);
      }
    } catch {
      if (selection !== chatSelection.current) return;
      setChatId(previousId);
      selectedChatKey.current = previousKey;
      setMessages(previousMessages);
      setError("Не удалось открыть диалог");
    } finally {
      if (selection === chatSelection.current) setChatLoading(false);
    }
  }

  async function clearDialog() {
    const deletingId = chatId;
    const deletingKey = selectedChatKey.current;
    activeRequests.current.get(deletingKey)?.abort();
    ++chatSelection.current;
    setChatLoading(true);
    if (chatId) {
      let response: Response | undefined;
      try {
        for (let attempt = 0; attempt < 10; attempt++) {
          response = await fetch(`/api/ai/chats/${chatId}`, {
            method: "DELETE",
          });
          if (response.status !== 409) break;
          await new Promise((resolve) => setTimeout(resolve, 200));
        }
      } catch {
        setError("Не удалось удалить диалог");
        setChatLoading(false);
        return;
      }
      if (!response) {
        setChatLoading(false);
        return;
      }
      if (!response.ok && response.status !== 404) {
        const data = await response.json().catch(() => ({}));
        setError(
          typeof data.error === "string"
            ? data.error
            : "Не удалось удалить диалог",
        );
        setChatLoading(false);
        return;
      }
      setChats((current) => current.filter((item) => item.id !== chatId));
    }
    setServerBusyChats((current) => ({ ...current, [deletingId]: false }));
    activeRequests.current.delete(deletingKey);
    setWorkingChats((current) => {
      const next = { ...current };
      delete next[deletingKey];
      return next;
    });
    setChatId("");
    chatMessages.current.delete(selectedChatKey.current);
    chatErrors.current.delete(selectedChatKey.current);
    pendingUiActions.current.delete(selectedChatKey.current);
    selectedChatKey.current = `new:${crypto.randomUUID()}`;
    setMessages([]);
    setDraft("");
    setError("");
    setReviewedSuggestions({});
    setChatLoading(false);
  }

  async function send(text = draft, selectedPersonId?: string) {
    const message = text.trim();
    let jobKey = selectedChatKey.current;
    if (
      (!message && !selectedPersonId) ||
      activeRequests.current.has(jobKey) ||
      serverBusyChats[chatId] ||
      chatLoading
    )
      return;
    if (selectedPersonId && !chatId) return;
    const controller = new AbortController();
    const isCurrent = () =>
      activeRequests.current.get(jobKey) === controller &&
      !controller.signal.aborted;
    activeRequests.current.set(jobKey, controller);
    chatErrors.current.delete(jobKey);
    if (!selectedPersonId) {
      const next = [
        ...(chatMessages.current.get(jobKey) || messages),
        { role: "user" as const, content: message },
      ];
      chatMessages.current.set(jobKey, next);
      setMessages(next);
      setDraft("");
    }
    setWorkingChats((current) => ({
      ...current,
      [jobKey]: { status: "Обрабатываю запрос…", activities: [] },
    }));
    setError("");
    try {
      const response = await fetch("/api/ai/chat/stream", {
        method: "POST",
        signal: controller.signal,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          message,
          ...(selectedPersonId ? { selectedPersonId } : {}),
          ...(chatId ? { chatId } : {}),
          context: {
            view,
            personIds,
            openPersonId,
            openPhotoId,
            timeZone: browserTimeZone(),
          },
        }),
      });
      if (!response.ok) {
        if (response.status === 409 && chatId)
          setServerBusyChats((current) => ({ ...current, [chatId]: true }));
        const data = await response.json().catch(() => ({}));
        throw new Error(
          (data as { error?: string }).error || "ИИ-исследователь не ответил",
        );
      }
      if (!response.body) throw new Error("Сервер не вернул поток ответа");

      const reader = response.body.getReader(),
        decoder = new TextDecoder();
      let buffer = "",
        finished = false;

      const steps: string[] = [];

      const consume = (frame: string) => {
        if (!isCurrent()) return;
        const parsed = parseSseFrame(frame);
        if (!parsed.data) return;
        const data = JSON.parse(parsed.data) as Partial<ResearchResult> & {
          text?: string;
          message?: string;
          error?: string;
          chatId?: string;
        };
        if (parsed.event === "chat" && data.chatId) {
          const id = data.chatId;
          if (jobKey !== id) {
            const oldKey = jobKey;
            activeRequests.current.delete(oldKey);
            activeRequests.current.set(id, controller);
            const cached = chatMessages.current.get(oldKey);
            if (cached) {
              chatMessages.current.set(id, cached);
              chatMessages.current.delete(oldKey);
            }
            setWorkingChats((current) => {
              const next = {
                ...current,
                [id]: current[oldKey] || {
                  status: "Обрабатываю запрос…",
                  activities: [],
                },
              };
              delete next[oldKey];
              return next;
            });
            if (selectedChatKey.current === oldKey) {
              selectedChatKey.current = id;
              setChatId(id);
            }
            jobKey = id;
          }
          setChats((current) =>
            current.some((item) => item.id === data.chatId)
              ? current
              : [
                  {
                    id: data.chatId!,
                    title: message.slice(0, 80),
                    updatedAt: new Date().toISOString(),
                  },
                  ...current,
                ],
          );
          return;
        }
        if (parsed.event === "status") {
          if (data.message && data.message !== "Соединение установлено") {
            if (!steps.includes(data.message)) {
              steps.push(data.message);
            }
            setWorkingChats((current) => ({
              ...current,
              [jobKey]: { status: data.message!, activities: [...steps] },
            }));
          }
          return;
        }
        if (parsed.event === "delta") {
          return;
        }
        if (parsed.event === "done") {
          finished = true;
          setServerBusyChats((current) => ({ ...current, [jobKey]: false }));
          if (data.chatId) {
            setChats((current) => [
              {
                id: data.chatId!,
                title:
                  current.find((item) => item.id === data.chatId)?.title ||
                  message.slice(0, 80),
                updatedAt: new Date().toISOString(),
              },
              ...current.filter((item) => item.id !== data.chatId),
            ]);
          }
          const next = [
            ...(chatMessages.current.get(jobKey) || []),
            {
              role: "assistant",
              content: data.answer || "Модель не сформировала текстовый ответ.",
              references: Array.isArray(data.references) ? data.references : [],
              suggestionIds: Array.isArray(data.suggestionIds)
                ? data.suggestionIds
                : [],
              files: Array.isArray(data.files) ? data.files : [],
              activities: steps,
            },
          ] as Message[];
          chatMessages.current.set(jobKey, next);
          chatErrors.current.delete(jobKey);
          if (selectedChatKey.current === jobKey) {
            setMessages(next);
            applyUiActions(data.uiActions || []);
          } else if (data.uiActions?.length)
            pendingUiActions.current.set(jobKey, data.uiActions);
          return;
        }
        if (parsed.event === "error") {
          setServerBusyChats((current) => ({ ...current, [jobKey]: false }));
          throw new Error(data.error || "Ошибка потокового ответа ИИ");
        }
      };

      try {
        while (true) {
          const { value, done } = await reader.read();
          if (!isCurrent()) return;
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
          throw new Error("Соединение прервалось. Проверяю сохранённый ответ…");
      } finally {
        await reader.cancel().catch(() => {});
        reader.releaseLock();
      }

      if (canEdit && isCurrent()) await loadSuggestions();
    } catch (reason) {
      if (isCurrent()) {
        const message = (reason as Error).message;
        chatErrors.current.set(jobKey, message);
        if (selectedChatKey.current === jobKey) setError(message);
      }
    } finally {
      if (activeRequests.current.get(jobKey) === controller) {
        activeRequests.current.delete(jobKey);
        setWorkingChats((current) => {
          const next = { ...current };
          delete next[jobKey];
          return next;
        });
      }
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
      if (
        data.suggestion?.status !==
        (action === "accept" ? "accepted" : "rejected")
      )
        throw new Error(
          "Сервер не подтвердил изменение. Обновите список предложений.",
        );
      const reviewed = suggestions.find((suggestion) => suggestion.id === id);
      setSuggestions((current) =>
        current.filter((suggestion) => suggestion.id !== id),
      );
      setReviewedSuggestions((current) =>
        reviewed
          ? {
              ...current,
              [id]: {
                status: action === "accept" ? "accepted" : "rejected",
                kind: reviewed.kind,
                personName: reviewed.personName,
              },
            }
          : current,
      );
      if (action === "accept")
        onChanged(
          reviewed?.kind === "person_create"
            ? data.suggestion.personId
            : undefined,
        );
    } catch (reason) {
      setError((reason as Error).message);
    } finally {
      setReviewBusy("");
    }
  }

  return (
    <>
      {!open && (
        <>
          {nudgeVisible && (
            <span
              className={`research-assistant-nudge${view === "tree" ? " is-tree-view" : ""}${view === "tree" && launcherPosition ? " has-position" : ""}`}
              style={
                view === "tree" && launcherPosition
                  ? {
                      left: launcherPosition.left + 21,
                      top: Math.max(8, launcherPosition.top - 45),
                    }
                  : undefined
              }
              role="status"
            >
              Нужна помощь?
            </span>
          )}
          <button
            type="button"
            className={`research-assistant-trigger${view === "tree" ? " is-tree-view" : ""}${nudgeVisible ? " is-nudging" : ""}`}
            style={
              view === "tree" && launcherPosition
                ? {
                    left: launcherPosition.left,
                    top: launcherPosition.top,
                    right: "auto",
                    bottom: "auto",
                  }
                : undefined
            }
            aria-expanded={false}
            aria-label="Открыть ИИ-исследователя"
            title="ИИ-исследователь"
            onClick={() => void openAssistant()}
          >
            <Sparkles size={19} />
          </button>
        </>
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
          {RESIZE_DIRECTIONS.map(({ direction, label }) => (
            <button
              key={direction}
              type="button"
              className={`research-resize-handle is-${direction}`}
              data-testid={`research-resize-${direction}`}
              aria-label={label}
              tabIndex={direction.length === 1 ? 0 : -1}
              onPointerDown={(event) => startResize(direction, event)}
              onPointerMove={moveResize}
              onPointerUp={stopResize}
              onPointerCancel={stopResize}
              onKeyDown={(event) => resizeWithKeyboard(direction, event)}
            />
          ))}
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
            <div className="research-assistant-header-actions">
              <button
                type="button"
                aria-label={chatId ? "Удалить диалог" : "Очистить диалог"}
                title={chatId ? "Удалить диалог" : "Очистить диалог"}
                disabled={
                  chatLoading ||
                  (!chatId && !messages.length && !draft && !error)
                }
                onClick={() => void clearDialog()}
              >
                <Trash2 size={17} />
              </button>
              <button
                type="button"
                aria-label="Закрыть ИИ-исследователя"
                title="Закрыть"
                onClick={() => setOpen(false)}
              >
                <X size={18} />
              </button>
            </div>
          </header>
          {(chats.length > 0 || busy) && (
            <div className="research-chat-picker" ref={chatPicker}>
              <button
                ref={chatPickerTrigger}
                type="button"
                className="research-chat-picker-trigger"
                aria-label="Выбрать диалог"
                aria-expanded={chatMenuOpen}
                aria-controls="research-chat-menu"
                disabled={chatLoading}
                onClick={() => setChatMenuOpen((value) => !value)}
              >
                <span>
                  {chats.find((item) => item.id === chatId)?.title ||
                    "Новый диалог"}
                </span>
                {busy && (
                  <LoaderCircle
                    className="research-chat-working"
                    size={15}
                    aria-label="ИИ отвечает"
                  />
                )}
                <ChevronDown size={16} aria-hidden="true" />
              </button>
              {chatMenuOpen && (
                <div
                  id="research-chat-menu"
                  className="research-chat-menu"
                  aria-label="Диалоги"
                >
                  {chats.length > 8 && (
                    <input
                      type="search"
                      aria-label="Поиск диалога"
                      placeholder="Найти диалог"
                      value={chatSearch}
                      onChange={(event) => setChatSearch(event.target.value)}
                    />
                  )}
                  <div className="research-chat-menu-list">
                    <button
                      type="button"
                      aria-current={!chatId ? "true" : undefined}
                      onClick={() => void openChat("")}
                    >
                      Новый диалог
                    </button>
                    {chats
                      .filter((item) =>
                        item.title
                          .toLocaleLowerCase("ru")
                          .includes(chatSearch.trim().toLocaleLowerCase("ru")),
                      )
                      .map((item) => (
                        <button
                          key={item.id}
                          type="button"
                          aria-current={item.id === chatId ? "true" : undefined}
                          title={item.title}
                          onClick={() => void openChat(item.id)}
                        >
                          <span>{item.title}</span>
                          {workingChats[item.id] && (
                            <LoaderCircle
                              className="research-chat-working"
                              size={15}
                              aria-label="ИИ отвечает"
                            />
                          )}
                        </button>
                      ))}
                  </div>
                </div>
              )}
            </div>
          )}
          <div className="research-assistant-messages">
            {chatLoading && <p role="status">Загружаю историю…</p>}
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
                <strong>
                  {currentPersonName
                    ? `Здравствуйте, ${currentPersonName}!`
                    : "Здравствуйте!"}
                </strong>
                <p>
                  Я помогу разобраться в семейном архиве. Спросите меня о людях,
                  фотографиях, родстве или истории семьи.
                </p>
              </div>
            )}
            {messages.map((message, index) => (
              <div key={index}>
                {message.role === "assistant" &&
                  !!message.activities?.length && (
                    <details className="research-activity">
                      <summary>Как готовился ответ</summary>
                      <div className="research-activity-steps">
                        {message.activities.map((step, position) => (
                          <p key={position}>{step}</p>
                        ))}
                      </div>
                    </details>
                  )}
                <article className={`is-${message.role}`}>
                  {message.role === "assistant" ? (
                    <MarkdownAnswer
                      message={message}
                      onPerson={onPerson}
                      onChoosePerson={choosePerson}
                      onPhoto={onPhoto}
                    />
                  ) : (
                    <p>{message.content}</p>
                  )}
                  {message.role === "assistant" &&
                    message.files?.map((file) => (
                      <a
                        className="research-file"
                        key={file.url}
                        href={file.url}
                        download={file.name}
                      >
                        Скачать {file.name}
                      </a>
                    ))}
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
                          {reviewedSuggestions[id].status === "accepted"
                            ? reviewedSuggestions[id].kind === "person_create"
                              ? `✓ ${reviewedSuggestions[id].personName} добавлен в архив`
                              : `✓ Изменение для ${reviewedSuggestions[id].personName} сохранено`
                            : "× Предложение отклонено"}
                        </p>
                      ) : null;
                    })}
                </article>
              </div>
            ))}
            {busy && (
              <details className="research-activity" open>
                <summary>
                  <span role="status">
                    {streamStatus || "ИИ формирует ответ…"}
                  </span>
                </summary>
                {activities.length > 1 && (
                  <div className="research-activity-steps">
                    {activities.slice(0, -1).map((step, position) => (
                      <p key={position}>{step}</p>
                    ))}
                  </div>
                )}
              </details>
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
              ref={composer}
              value={draft}
              disabled={chatLoading}
              rows={1}
              maxLength={8000}
              placeholder="Спросите об архиве…"
              onChange={(event) => setDraft(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter" && !event.shiftKey) {
                  event.preventDefault();
                  void send();
                }
              }}
            />
            {(busy || draft.trim()) && (
              <button
                type={busy ? "button" : "submit"}
                className="primary-action"
                disabled={chatLoading}
                aria-label={busy ? "Остановить ответ" : "Отправить запрос"}
                title={busy ? "Остановить ответ" : "Отправить запрос"}
                onClick={busy ? () => void stopGeneration() : undefined}
              >
                {busy ? (
                  <Square size={15} fill="currentColor" />
                ) : (
                  <Send size={17} />
                )}
              </button>
            )}
          </form>
        </aside>
      )}
    </>
  );
}
