import {
  memo,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
} from "react";
import { createPortal } from "react-dom";
import {
  Check,
  ChevronDown,
  Minus,
  Plus,
  RotateCcw,
  Send,
  Sparkles,
  Square,
  Trash2,
  X,
} from "lucide-react";
import ReactMarkdown, {
  defaultUrlTransform,
  type Components,
} from "react-markdown";
import remarkGfm from "remark-gfm";
import {
  linkResearchReferences,
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
type UiAction =
  | { type: "focus_people"; personIds: string[] }
  | { type: "filter_people"; personIds: string[]; label: string }
  | { type: "open_person"; personId: string }
  | { type: "open_photo"; photoId: string }
  | { type: "zoom_in" | "zoom_out" };

type PanelPosition = { left: number; top: number };
type LauncherPosition = { left: number; top: number };
type ResizeDirection = "n" | "ne" | "e" | "se" | "s" | "sw" | "w" | "nw";
type PanelRect = {
  left: number;
  top: number;
  width: number;
  height: number;
};
const RESIZE_DIRECTIONS: Array<{
  direction: ResizeDirection;
  label: string;
}> = [
  {
    direction: "n",
    label: "Изменить высоту сверху",
  },
  { direction: "ne", label: "Изменить размер сверху справа" },
  { direction: "e", label: "Изменить ширину справа" },
  { direction: "se", label: "Изменить размер снизу справа" },
  { direction: "s", label: "Изменить высоту снизу" },
  { direction: "sw", label: "Изменить размер снизу слева" },
  { direction: "w", label: "Изменить ширину слева" },
  { direction: "nw", label: "Изменить размер сверху слева" },
];

let mermaidModule: Promise<(typeof import("mermaid"))["default"]> | undefined;
let mermaidRenderId = 0;
const mermaidSvgCache = new Map<string, string>(),
  mermaidSvgPending = new Map<string, Promise<string>>();

function renderMermaid(source: string) {
  const cached = mermaidSvgCache.get(source);
  if (cached) return Promise.resolve(cached);
  const pending = mermaidSvgPending.get(source);
  if (pending) return pending;
  mermaidModule ||= import("mermaid").then(async (module) => {
    module.default.initialize({
      startOnLoad: false,
      securityLevel: "strict",
      look: "classic",
      theme: "base",
      themeVariables: {
        fontFamily: "system-ui, sans-serif",
        fontSize: "13px",
        primaryColor: "#ffffff",
        primaryBorderColor: "#a7b7a6",
        primaryTextColor: "#2f4134",
        secondaryColor: "#f3f6f1",
        tertiaryColor: "#ffffff",
        lineColor: "#68826f",
      },
      flowchart: {
        defaultRenderer: "elk",
        useMaxWidth: false,
        curve: "linear",
        htmlLabels: false,
        nodeSpacing: 36,
        rankSpacing: 54,
        diagramPadding: 12,
      },
      elk: {
        mergeEdges: true,
        nodePlacementStrategy: "BRANDES_KOEPF",
        cycleBreakingStrategy: "GREEDY",
      },
    });
    module.default.registerLayoutLoaders(
      (await import("@mermaid-js/layout-elk")).default,
    );
    return module.default;
  });
  const rendering = mermaidModule
    .then((mermaid) => mermaid.render(`drevo-ai-${++mermaidRenderId}`, source))
    .then(({ svg }) => {
      if (mermaidSvgCache.size >= 32)
        mermaidSvgCache.delete(mermaidSvgCache.keys().next().value!);
      mermaidSvgCache.set(source, svg);
      return svg;
    })
    .finally(() => mermaidSvgPending.delete(source));
  mermaidSvgPending.set(source, rendering);
  return rendering;
}

function MermaidDiagram({ source }: { source: string }) {
  const [expanded, setExpanded] = useState(false),
    [zoom, setZoom] = useState(1),
    [panning, setPanning] = useState(false);
  const drag = useRef<{
    pointerId: number;
    x: number;
    y: number;
    left: number;
    top: number;
  } | null>(null);
  const [rendered, setRendered] = useState<{
    source: string;
    svg: string;
    error: string;
  }>(() => ({ source, svg: mermaidSvgCache.get(source) || "", error: "" }));
  const cached = mermaidSvgCache.get(source) || "",
    svg = rendered.source === source ? rendered.svg : cached,
    error = rendered.source === source ? rendered.error : "";

  useEffect(() => {
    if (mermaidSvgCache.has(source)) return;
    let active = true;
    void renderMermaid(source)
      .then((value) => {
        if (active) setRendered({ source, svg: value, error: "" });
      })
      .catch(() => {
        if (active)
          setRendered({ source, svg: "", error: "Не удалось построить схему" });
      });
    return () => {
      active = false;
    };
  }, [source]);

  useEffect(() => {
    if (!expanded) return;
    const close = (event: globalThis.KeyboardEvent) => {
      if (event.key === "Escape") setExpanded(false);
    };
    window.addEventListener("keydown", close);
    return () => window.removeEventListener("keydown", close);
  }, [expanded]);

  const viewBox = /viewBox="[\d.-]+ [\d.-]+ ([\d.]+) ([\d.]+)"/.exec(svg),
    naturalWidth = viewBox ? Number(viewBox[1]) : 900;

  return error ? (
    <pre className="research-mermaid-error">{error}</pre>
  ) : (
    <>
      <div className="research-mermaid">
        {svg && (
          <button
            type="button"
            className="research-mermaid-expand"
            onClick={() => {
              setZoom(1);
              setExpanded(true);
            }}
            aria-label="Развернуть схему"
            title="Развернуть схему"
          >
            <span aria-hidden="true">⛶</span>
          </button>
        )}
        <div
          role="img"
          aria-label="Схема, построенная ИИ-исследователем"
          dangerouslySetInnerHTML={svg ? { __html: svg } : undefined}
        />
      </div>
      {expanded &&
        createPortal(
          <div
            className="research-mermaid-overlay"
            role="presentation"
            onMouseDown={(event) => {
              if (event.target === event.currentTarget) setExpanded(false);
            }}
          >
            <section
              className="research-mermaid-dialog"
              role="dialog"
              aria-modal="true"
              aria-label="Схема родства"
            >
              <header>
                <strong>Схема родства</strong>
                <div className="research-mermaid-controls">
                  <button
                    type="button"
                    aria-label="Уменьшить схему"
                    disabled={zoom <= 0.25}
                    onClick={() =>
                      setZoom((value) =>
                        Math.max(0.25, +(value / 1.25).toFixed(2)),
                      )
                    }
                  >
                    <Minus size={18} />
                  </button>
                  <span aria-live="polite">{Math.round(zoom * 100)}%</span>
                  <button
                    type="button"
                    aria-label="Увеличить схему"
                    disabled={zoom >= 4}
                    onClick={() =>
                      setZoom((value) =>
                        Math.min(4, +(value * 1.25).toFixed(2)),
                      )
                    }
                  >
                    <Plus size={18} />
                  </button>
                  <button
                    type="button"
                    aria-label="Сбросить масштаб"
                    onClick={() => setZoom(1)}
                  >
                    <RotateCcw size={17} />
                  </button>
                  <button
                    type="button"
                    aria-label="Закрыть схему"
                    onClick={() => setExpanded(false)}
                  >
                    <X size={19} />
                  </button>
                </div>
              </header>
              <div
                className={`research-mermaid-canvas${panning ? " is-panning" : ""}`}
                onPointerDown={(event) => {
                  if (event.button !== 0) return;
                  const target = event.currentTarget;
                  drag.current = {
                    pointerId: event.pointerId,
                    x: event.clientX,
                    y: event.clientY,
                    left: target.scrollLeft,
                    top: target.scrollTop,
                  };
                  target.setPointerCapture(event.pointerId);
                  setPanning(true);
                  event.preventDefault();
                }}
                onPointerMove={(event) => {
                  const start = drag.current;
                  if (!start || start.pointerId !== event.pointerId) return;
                  event.currentTarget.scrollLeft =
                    start.left - (event.clientX - start.x);
                  event.currentTarget.scrollTop =
                    start.top - (event.clientY - start.y);
                }}
                onPointerUp={(event) => {
                  if (drag.current?.pointerId !== event.pointerId) return;
                  drag.current = null;
                  event.currentTarget.releasePointerCapture(event.pointerId);
                  setPanning(false);
                }}
                onPointerCancel={() => {
                  drag.current = null;
                  setPanning(false);
                }}
              >
                <div
                  style={{ width: `${Math.max(300, naturalWidth * zoom)}px` }}
                  dangerouslySetInnerHTML={{ __html: svg }}
                />
              </div>
            </section>
          </div>,
          document.body,
        )}
    </>
  );
}

function resizedPanelRect(
  rect: PanelRect,
  direction: ResizeDirection,
  deltaX: number,
  deltaY: number,
  viewportWidth: number,
  viewportHeight: number,
) {
  const margin = 8,
    minWidth = Math.min(340, viewportWidth - margin * 2),
    minHeight = Math.min(420, viewportHeight - margin * 2);
  let left = rect.left,
    right = rect.left + rect.width,
    top = rect.top,
    bottom = rect.top + rect.height;
  if (direction.includes("e"))
    right = Math.min(
      viewportWidth - margin,
      Math.max(left + minWidth, right + deltaX),
    );
  if (direction.includes("w"))
    left = Math.max(margin, Math.min(right - minWidth, left + deltaX));
  if (direction.includes("s"))
    bottom = Math.min(
      viewportHeight - margin,
      Math.max(top + minHeight, bottom + deltaY),
    );
  if (direction.includes("n"))
    top = Math.max(margin, Math.min(bottom - minHeight, top + deltaY));
  return { left, top, width: right - left, height: bottom - top };
}

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
          <MermaidDiagram source={String(children).trim()} />
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
        {linkResearchReferences(message.content, message.references)}
      </ReactMarkdown>
    </div>
  );
});
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
          className="primary-action"
          disabled={disabled}
          aria-label="Принять предложение"
          title="Принять"
          onClick={() => onReview(suggestion.id, "accept")}
        >
          <Check size={17} aria-hidden="true" /> Принять
        </button>
        <button
          type="button"
          disabled={disabled}
          aria-label="Отклонить предложение"
          title="Отклонить"
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
  currentPersonName?: string;
  nudgeToken?: number;
  canEdit: boolean;
  onChanged: () => void;
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
    [suggestions, setSuggestions] = useState<ResearchSuggestion[]>([]),
    [busy, setBusy] = useState(false),
    [reviewBusy, setReviewBusy] = useState(""),
    [reviewedSuggestions, setReviewedSuggestions] = useState<
      Record<string, "accepted" | "rejected">
    >({}),
    [streamStatus, setStreamStatus] = useState(""),
    [activities, setActivities] = useState<string[]>([]),
    [error, setError] = useState(""),
    [panelPosition, setPanelPosition] = useState<PanelPosition | null>(null),
    [launcherPosition, setLauncherPosition] = useState<LauncherPosition | null>(
      null,
    ),
    [nudgeVisible, setNudgeVisible] = useState(false);
  const end = useRef<HTMLDivElement>(null),
    chatPicker = useRef<HTMLDivElement>(null),
    chatPickerTrigger = useRef<HTMLButtonElement>(null),
    panel = useRef<HTMLElement>(null),
    lastNudge = useRef(0),
    drag = useRef<{
      pointerId: number;
      offsetX: number;
      offsetY: number;
      left: number;
      top: number;
    } | null>(null),
    resize = useRef<{
      pointerId: number;
      direction: ResizeDirection;
      startX: number;
      startY: number;
      startRect: PanelRect;
      latest: PanelRect;
    } | null>(null),
    chatSelection = useRef(0),
    requestSequence = useRef(0),
    activeRequest = useRef<AbortController | null>(null),
    sendLatest = useRef<
      (text?: string, selectedPersonId?: string) => Promise<void>
    >(() => Promise.resolve());

  useEffect(() => {
    onOpenChange?.(open);
    return () => onOpenChange?.(false);
  }, [onOpenChange, open]);

  useEffect(() => () => activeRequest.current?.abort(), []);

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

  const clampPanelPosition = useCallback((left: number, top: number) => {
    const rect = panel.current?.getBoundingClientRect(),
      width = rect?.width || 430,
      height = rect?.height || 680,
      margin = 8;
    return {
      left: Math.min(
        Math.max(margin, left),
        Math.max(margin, innerWidth - width - margin),
      ),
      top: Math.min(
        Math.max(margin, top),
        Math.max(margin, innerHeight - height - margin),
      ),
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

  useEffect(() => {
    if (!open || !panel.current || typeof ResizeObserver === "undefined")
      return;
    const observer = new ResizeObserver(() => {
      setPanelPosition((current) => {
        if (!current) return current;
        const next = clampPanelPosition(current.left, current.top);
        return next.left === current.left && next.top === current.top
          ? current
          : next;
      });
    });
    observer.observe(panel.current);
    return () => observer.disconnect();
  }, [open, clampPanelPosition]);

  const startDrag = (event: ReactPointerEvent<HTMLElement>) => {
    if (
      event.button !== 0 ||
      innerWidth <= 600 ||
      (event.target as HTMLElement).closest(
        "button, a, input, select, textarea",
      )
    )
      return;
    const rect = panel.current?.getBoundingClientRect();
    if (!rect) return;
    drag.current = {
      pointerId: event.pointerId,
      offsetX: event.clientX - rect.left,
      offsetY: event.clientY - rect.top,
      left: rect.left,
      top: rect.top,
    };
    setPanelPosition({ left: rect.left, top: rect.top });
    panel.current?.classList.add("is-dragging");
    event.currentTarget.setPointerCapture(event.pointerId);
  };

  const moveDrag = (event: ReactPointerEvent<HTMLElement>) => {
    const state = drag.current;
    if (!state || state.pointerId !== event.pointerId) return;
    const next = clampPanelPosition(
      event.clientX - state.offsetX,
      event.clientY - state.offsetY,
    );
    state.left = next.left;
    state.top = next.top;
    if (panel.current) {
      panel.current.style.left = `${next.left}px`;
      panel.current.style.top = `${next.top}px`;
      panel.current.style.right = "auto";
      panel.current.style.bottom = "auto";
    }
  };

  const stopDrag = (event: ReactPointerEvent<HTMLElement>) => {
    if (drag.current?.pointerId !== event.pointerId) return;
    const state = drag.current;
    drag.current = null;
    panel.current?.classList.remove("is-dragging");
    setPanelPosition({ left: state.left, top: state.top });
    if (event.currentTarget.hasPointerCapture(event.pointerId))
      event.currentTarget.releasePointerCapture(event.pointerId);
  };

  const applyPanelRect = (next: PanelRect) => {
    if (!panel.current) return;
    panel.current.style.left = `${next.left}px`;
    panel.current.style.top = `${next.top}px`;
    panel.current.style.right = "auto";
    panel.current.style.bottom = "auto";
    panel.current.style.width = `${next.width}px`;
    panel.current.style.height = `${next.height}px`;
  };

  const startResize = (
    direction: ResizeDirection,
    event: ReactPointerEvent<HTMLButtonElement>,
  ) => {
    if (event.button !== 0 || innerWidth <= 600 || !panel.current) return;
    event.preventDefault();
    event.stopPropagation();
    const rect = panel.current.getBoundingClientRect(),
      startRect = {
        left: rect.left,
        top: rect.top,
        width: rect.width,
        height: rect.height,
      };
    resize.current = {
      pointerId: event.pointerId,
      direction,
      startX: event.clientX,
      startY: event.clientY,
      startRect,
      latest: startRect,
    };
    setPanelPosition({ left: rect.left, top: rect.top });
    panel.current.classList.add("is-resizing");
    event.currentTarget.setPointerCapture(event.pointerId);
  };

  const moveResize = (event: ReactPointerEvent<HTMLButtonElement>) => {
    const state = resize.current;
    if (!state || state.pointerId !== event.pointerId) return;
    state.latest = resizedPanelRect(
      state.startRect,
      state.direction,
      event.clientX - state.startX,
      event.clientY - state.startY,
      innerWidth,
      innerHeight,
    );
    applyPanelRect(state.latest);
  };

  const stopResize = (event: ReactPointerEvent<HTMLButtonElement>) => {
    const state = resize.current;
    if (!state || state.pointerId !== event.pointerId) return;
    resize.current = null;
    panel.current?.classList.remove("is-resizing");
    setPanelPosition({ left: state.latest.left, top: state.latest.top });
    if (event.currentTarget.hasPointerCapture(event.pointerId))
      event.currentTarget.releasePointerCapture(event.pointerId);
  };

  const resizeWithKeyboard = (
    direction: ResizeDirection,
    event: ReactKeyboardEvent<HTMLButtonElement>,
  ) => {
    if (!panel.current || innerWidth <= 600) return;
    const step = event.shiftKey ? 32 : 12,
      horizontal =
        event.key === "ArrowLeft"
          ? -step
          : event.key === "ArrowRight"
            ? step
            : 0,
      vertical =
        event.key === "ArrowUp" ? -step : event.key === "ArrowDown" ? step : 0;
    if (!horizontal && !vertical) return;
    event.preventDefault();
    const rect = panel.current.getBoundingClientRect(),
      next = resizedPanelRect(
        {
          left: rect.left,
          top: rect.top,
          width: rect.width,
          height: rect.height,
        },
        direction,
        horizontal,
        vertical,
        innerWidth,
        innerHeight,
      );
    applyPanelRect(next);
    setPanelPosition({ left: next.left, top: next.top });
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

  function stopGeneration() {
    if (!activeRequest.current) return;
    requestSequence.current++;
    activeRequest.current.abort();
    activeRequest.current = null;
    setBusy(false);
    setStreamStatus("");
    setActivities([]);
  }

  async function openChat(id: string) {
    setChatMenuOpen(false);
    setChatSearch("");
    if (id === chatId && !activeRequest.current) return;
    stopGeneration();
    const selection = ++chatSelection.current;
    if (!id) {
      setChatId("");
      setMessages([]);
      setError("");
      setChatLoading(false);
      return;
    }
    const previousId = chatId;
    const previousMessages = messages;
    setChatId(id);
    setChatLoading(true);
    try {
      const response = await fetch(`/api/ai/chats/${id}`);
      if (!response.ok) throw new Error("Не удалось открыть диалог");
      const data = (await response.json()) as { messages: Message[] };
      if (selection !== chatSelection.current) return;
      setMessages(data.messages);
      setError("");
    } catch {
      if (selection !== chatSelection.current) return;
      setChatId(previousId);
      setMessages(previousMessages);
      setError("Не удалось открыть диалог");
    } finally {
      if (selection === chatSelection.current) setChatLoading(false);
    }
  }

  async function clearDialog() {
    stopGeneration();
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
      if (!response.ok) {
        setError("Не удалось удалить диалог");
        setChatLoading(false);
        return;
      }
      setChats((current) => current.filter((item) => item.id !== chatId));
    }
    setChatId("");
    setMessages([]);
    setDraft("");
    setError("");
    setStreamStatus("");
    setActivities([]);
    setReviewedSuggestions({});
    setChatLoading(false);
  }

  async function send(text = draft, selectedPersonId?: string) {
    const message = text.trim();
    if ((!message && !selectedPersonId) || activeRequest.current || chatLoading) return;
    if (selectedPersonId && !chatId) return;
    const controller = new AbortController();
    const generation = ++requestSequence.current;
    const isCurrent = () =>
      generation === requestSequence.current && !controller.signal.aborted;
    activeRequest.current = controller;
    if (!selectedPersonId) {
      setMessages((current) => [
        ...current,
        { role: "user", content: message },
      ]);
      setDraft("");
    }
    setBusy(true);
    setStreamStatus("Обрабатываю запрос…");
    setActivities([]);
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
          context: { view, personIds },
        }),
      });
      if (!response.ok) {
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
        const data = JSON.parse(parsed.data) as {
          text?: string;
          message?: string;
          answer?: string;
          error?: string;
          references?: AnswerReference[];
          suggestionIds?: string[];
          uiActions?: UiAction[];
          files?: Array<{ name: string; url: string }>;
          chatId?: string;
        };
        if (parsed.event === "chat" && data.chatId) {
          setChatId(data.chatId);
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
            setStreamStatus(data.message);
            if (!steps.includes(data.message)) {
              steps.push(data.message);
              setActivities([...steps]);
            }
          }
          return;
        }
        if (parsed.event === "delta") {
          return;
        }
        if (parsed.event === "done") {
          finished = true;
          if (data.chatId) {
            setChatId(data.chatId);
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
          setStreamStatus("");
          setActivities([]);
          setMessages((current) => [
            ...current,
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
          ]);
          for (const action of data.uiActions || []) {
            if (action.type === "focus_people") onReveal(action.personIds);
            else if (action.type === "filter_people")
              onFilter(action.personIds, action.label);
            else if (action.type === "open_person") onPerson(action.personId);
            else if (action.type === "open_photo") onPhoto(action.photoId);
            else if (action.type === "zoom_in") onZoom("in");
            else if (action.type === "zoom_out") onZoom("out");
          }
          return;
        }
        if (parsed.event === "error")
          throw new Error(data.error || "Ошибка потокового ответа ИИ");
      };

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
        throw new Error("Поток ответа завершился раньше события done");

      if (canEdit && isCurrent()) await loadSuggestions();
    } catch (reason) {
      if (isCurrent()) setError((reason as Error).message);
    } finally {
      if (generation === requestSequence.current) {
        activeRequest.current = null;
        setStreamStatus("");
        setActivities([]);
        setBusy(false);
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
              {busy && <button
                type="button"
                aria-label="Остановить ответ"
                title="Остановить ответ"
                onClick={stopGeneration}
              >
                <Square size={15} fill="currentColor" />
              </button>}
              <button
                type="button"
                aria-label={chatId ? "Удалить диалог" : "Очистить диалог"}
                title={chatId ? "Удалить диалог" : "Очистить диалог"}
                disabled={chatLoading || (!chatId && !messages.length && !draft && !error)}
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
                          {item.title}
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
                  <small>{message.role === "user" ? "Вы" : "Drevo AI"}</small>
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
                          {reviewedSuggestions[id] === "accepted"
                            ? "✓ Изменение применено"
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
              value={draft}
              disabled={chatLoading}
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
            {draft.trim() && (
              <button
                type="submit"
                className="primary-action"
                disabled={busy || chatLoading}
                aria-label="Отправить запрос"
              >
                <Send size={17} />
              </button>
            )}
          </form>
        </aside>
      )}
    </>
  );
}
