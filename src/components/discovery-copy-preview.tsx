import { useEffect, useRef, useState } from "react";
import { archiveFetch } from "../data/archive-fetch.ts";

const labels = {
  birth: "Дата рождения", death: "Дата смерти", birthPlace: "Место рождения",
  deathPlace: "Место смерти", occupation: "Род занятий",
} as const;
type Field = keyof typeof labels;
type Preview = {
  source: { archiveId: string; personId: string };
  target: { archiveId: string; personId: string };
  fields: { field: Field; sourceValue: string; targetValue: string | null;
    status: "empty" | "same" | "conflict" }[];
  quotaImpact: { additionalPeople: number; additionalMediaBytes: number };
};
const statusLabels = { empty: "Пустое поле", same: "Совпадает", conflict: "Конфликт" };

/** Read-only comparison: no field is written until a separate apply flow exists. */
export function DiscoveryCopyPreview({ matchId }: { matchId: string }) {
  const request = useRef<AbortController | null>(null);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => () => { request.current?.abort(); }, [matchId]);
  async function load() {
    request.current?.abort();
    const controller = new AbortController();
    request.current = controller;
    setPreview(null); setError(""); setBusy(true);
    try {
      const response = await archiveFetch(
        `/api/discovery/matches/${matchId}/card-share/copy-preview`,
        { cache: "no-store", signal: controller.signal },
      );
      const body = await response.json();
      if (controller.signal.aborted) return;
      if (!response.ok) throw new Error(body.error || "Предпросмотр недоступен");
      setPreview(body);
    } catch (reason) {
      if (!controller.signal.aborted) setError((reason as Error).message);
    } finally {
      if (request.current === controller) { request.current = null; setBusy(false); }
    }
  }
  return <section className="match-copy-preview">
    <h4>Предпросмотр копирования</h4>
    <p>Сравнение не меняет ваше дерево. Копирование полей пока недоступно.</p>
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
        <dd>Источник: {row.sourceValue}<br />Ваша карточка: {row.targetValue || "не заполнено"}</dd>
      </div>)}</dl>}
    </>}
  </section>;
}
