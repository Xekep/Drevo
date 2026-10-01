import { useCallback, useEffect, useRef, useState } from "react";
import { archiveFetch } from "../data/archive-fetch.ts";

const labels = {
  birth: "Дата рождения", death: "Дата смерти", birthPlace: "Место рождения",
  deathPlace: "Место смерти", occupation: "Род занятий",
} as const;
type Field = keyof typeof labels;
type Preview = {
  source: { archiveId: string; personId: string };
  target: { archiveId: string; personId: string };
  revision: number;
  reviewToken: string;
  fields: { field: Field; sourceValue: string; targetValue: string | null;
    status: "empty" | "same" | "conflict"; copyable?: boolean;
    copiedFrom?: { archiveId: string; personId: string; revision: number;
      copiedAt: string } }[];
  quotaImpact: { additionalPeople: number; additionalMediaBytes: number };
};
const statusLabels = { empty: "Пустое поле", same: "Совпадает", conflict: "Конфликт" };

/** Copies only explicitly selected date/place fields into the existing local card. */
export function DiscoveryCopyPreview({ matchId }: { matchId: string }) {
  const request = useRef<AbortController | null>(null);
  const version = useRef(0);
  const active = useRef(true);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [selected, setSelected] = useState<Field[]>([]);
  const [confirmed, setConfirmed] = useState<Field[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const cancel = useCallback(() => {
    active.current = false; version.current++; request.current?.abort();
  }, []);
  useEffect(() => {
    active.current = true;
    return cancel;
  }, [matchId, cancel]);
  async function load(preserveNotice = false) {
    request.current?.abort();
    const controller = new AbortController();
    request.current = controller;
    const current = ++version.current;
    setPreview(null); setSelected([]); setConfirmed([]);
    setError(""); if (!preserveNotice) setNotice(""); setBusy(true);
    try {
      const response = await archiveFetch(
        `/api/discovery/matches/${matchId}/card-share/copy-preview`,
        { cache: "no-store", signal: controller.signal },
      );
      const body = await response.json();
      if (controller.signal.aborted || !active.current || current !== version.current) return;
      if (!response.ok) throw new Error(body.error || "Предпросмотр недоступен");
      setPreview(body);
    } catch (reason) {
      if (!controller.signal.aborted && active.current && current === version.current)
        setError((reason as Error).message);
    } finally {
      if (active.current && current === version.current) {
        request.current = null; setBusy(false);
      }
    }
  }
  async function copy() {
    if (!preview || !selected.length) return;
    const current = version.current;
    setBusy(true); setError(""); setNotice("");
    try {
      const response = await archiveFetch(
        `/api/discovery/matches/${matchId}/card-share/copy-preview`, {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ fields: selected, confirmConflicts: confirmed,
            revision: preview.revision, reviewToken: preview.reviewToken }),
        });
      const body = await response.json();
      if (!active.current || current !== version.current) return;
      if (!response.ok) throw new Error(body.error || "Не удалось скопировать сведения");
      setNotice("Выбранные сведения скопированы в вашу карточку. Происхождение сохранено.");
      await load(true);
    } catch (reason) {
      if (!active.current || current !== version.current) return;
      await load(true);
      if (active.current) setError((reason as Error).message);
    } finally {
      if (active.current && current === version.current) setBusy(false);
    }
  }
  const unconfirmed = preview?.fields.some((row) => selected.includes(row.field) &&
    row.status === "conflict" && !confirmed.includes(row.field));
  return <section className="match-copy-preview">
    <h4>Предпросмотр копирования</h4>
    <p>Выберите даты и места для своей существующей карточки. Замена несовпадающего значения
      требует отдельного подтверждения. Родственники, файлы, род занятий и документальные
      источники не копируются. Уже скопированные сведения останутся после отзыва разрешения.</p>
    <button type="button" disabled={busy} onClick={() => void load()}>
      Сравнить с моей карточкой
    </button>
    {busy && <p role="status">Проверяем разрешение и поля…</p>}
    {error && <p role="alert" className="form-error">{error}</p>}
    {preview && <>
      <p>Источник: разрешённая связанная карточка другого архива. Сравниваем с вашей карточкой.</p>
      {preview.fields.length === 0 && <p>Нет разрешённых текстовых полей для сравнения.</p>}
      {preview.fields.length > 0 && <dl className="match-shared-fields">{preview.fields.map((row) => <div key={row.field}>
        <dt>{labels[row.field]} · {statusLabels[row.status]}</dt>
        <dd>Источник: {row.sourceValue}<br />Ваша карточка: {row.targetValue || "не заполнено"}
          {row.copiedFrom && <small> · Значение ранее скопировано из другого архива</small>}
          {row.copyable && row.status !== "same" && <>
            <label className="match-share-option"><input type="checkbox" disabled={busy}
              checked={selected.includes(row.field)} onChange={(event) => {
                setSelected((current) => event.target.checked
                  ? [...current, row.field] : current.filter((field) => field !== row.field));
                if (!event.target.checked) setConfirmed((current) =>
                  current.filter((field) => field !== row.field));
              }} />Скопировать {labels[row.field].toLowerCase()}</label>
            {row.status === "conflict" && selected.includes(row.field) &&
              <label className="match-share-option"><input type="checkbox" disabled={busy}
                checked={confirmed.includes(row.field)} onChange={(event) => setConfirmed((current) =>
                  event.target.checked ? [...current, row.field]
                    : current.filter((field) => field !== row.field))} />
                Подтверждаю замену моего значения</label>}
          </>}
          {!row.copyable && <small> · Пока доступно только сравнение</small>}
        </dd>
      </div>)}</dl>}
      <button type="button" disabled={busy || !selected.length || unconfirmed}
        onClick={() => void copy()}>Скопировать выбранные поля</button>
    </>}
    {notice && <p role="status" className="admin-notice">{notice}</p>}
  </section>;
}
