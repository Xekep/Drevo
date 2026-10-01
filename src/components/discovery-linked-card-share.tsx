import { useState } from "react";
import { archiveFetch } from "../data/archive-fetch.ts";

const labels = {
  birth: "Полная дата рождения",
  death: "Полная дата смерти",
  birthPlace: "Место рождения",
  deathPlace: "Место смерти",
  occupation: "Род занятий",
} as const;
type Field = keyof typeof labels;
type SharedFields = Partial<Record<Field, string>>;
type Grant = { fields: SharedFields; grantedAt: string } | null;
type Detail = {
  available: SharedFields;
  previewToken: string;
  outgoing: Grant;
  incoming: Grant;
};

function Fields({ values }: { values: SharedFields }) {
  return <dl className="match-shared-fields">{(Object.keys(labels) as Field[])
    .filter((key) => values[key]).map((key) => <div key={key}>
      <dt>{labels[key]}</dt><dd>{values[key]}</dd>
    </div>)}</dl>;
}

export function DiscoveryLinkedCardShare({ matchId }: { matchId: string }) {
  const [detail, setDetail] = useState<Detail | null>(null);
  const [selected, setSelected] = useState<Field[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const endpoint = `/api/discovery/matches/${matchId}/card-share`;
  async function load(preserveError = false) {
    setBusy(true); if (!preserveError) setError("");
    try {
      const response = await archiveFetch(endpoint, { cache: "no-store" });
      const body = await response.json();
      if (!response.ok) throw new Error(body.error || "Не удалось открыть разрешённые сведения");
      setDetail(body);
      setSelected(Object.keys(body.outgoing?.fields || {}) as Field[]);
    } catch (reason) {
      setDetail(null);
      setSelected([]);
      setError((reason as Error).message);
    }
    finally { setBusy(false); }
  }
  async function save(method: "PUT" | "DELETE") {
    if (!detail) return;
    setBusy(true); setError(""); setNotice("");
    try {
      const response = await archiveFetch(endpoint, {
        method,
        ...(method === "PUT" ? {
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ fields: selected, previewToken: detail.previewToken }),
        } : {}),
      });
      const body = await response.json();
      if (!response.ok) throw new Error(body.error || "Не удалось изменить разрешение");
      setNotice(method === "PUT" ? "Выбранные сведения открыты другой стороне." : "Доступ к дополнительным сведениям отозван.");
      await load();
    } catch (reason) {
      setError((reason as Error).message);
      if (method === "PUT") await load(true);
    } finally { setBusy(false); }
  }
  return <details className="match-card-share" onToggle={(event) => {
    if (event.currentTarget.open && !detail && !busy) void load();
  }}>
    <summary>Дополнительные сведения связанной карточки</summary>
    <p>Только администратор другого дерева увидит выбранный снимок вашей карточки. Фото, документы, источники и родственники не передаются. Изменения карточки после отправки не обновляют снимок автоматически.</p>
    {busy && !detail && <p role="status">Загружаем…</p>}
    {detail && <>
      <h4>Разрешить другой стороне</h4>
      {(Object.keys(labels) as Field[]).filter((key) => detail.available[key]).length === 0 &&
        <p>В этой карточке нет дополнительных текстовых полей для передачи.</p>}
      {(Object.keys(labels) as Field[]).filter((key) => detail.available[key]).map((key) =>
        <label className="match-share-option" key={key}>
          <input type="checkbox" checked={selected.includes(key)} disabled={busy}
            onChange={(event) => setSelected((current) => event.target.checked
              ? [...current,key] : current.filter((item) => item !== key))} />
          <span><strong>{labels[key]}</strong>: {detail.available[key]}</span>
        </label>)}
      <div className="match-request-actions">
        <button type="button" disabled={busy || !selected.length} onClick={() => void save("PUT")}>Поделиться выбранным</button>
        {detail.outgoing && <button type="button" disabled={busy} onClick={() => void save("DELETE")}>Отозвать доступ</button>}
      </div>
      {detail.outgoing && <><h4>Сейчас открыто другой стороне</h4><Fields values={detail.outgoing.fields} /></>}
      <h4>Другая сторона открыла вам</h4>
      {detail.incoming ? <Fields values={detail.incoming.fields} /> : <p>Дополнительные сведения пока не открыты.</p>}
    </>}
    {error && <p role="alert" className="form-error">{error}</p>}
    {notice && <p role="status" className="admin-notice">{notice}</p>}
  </details>;
}
