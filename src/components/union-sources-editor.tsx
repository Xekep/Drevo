import { useEffect, useState } from "react";
import { archiveFetch } from "../data/archive-fetch.ts";
import type { Source } from "../domain/types.ts";
import { sourceCitation, type CatalogSource } from "../shared/source-catalog.ts";
import "../styles/union-sources-editor.css";

type CatalogEntry = CatalogSource & { version: number };

function CatalogPicker({ existing, onChoose }: {
  existing: Source[];
  onChoose: (source: CatalogEntry) => void;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [entries, setEntries] = useState<CatalogEntry[]>([]);
  const [total, setTotal] = useState(0);
  const [offset, setOffset] = useState(0);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [forbidden, setForbidden] = useState(false);
  const [retry, setRetry] = useState(0);

  useEffect(() => {
    if (!open || forbidden) return;
    const controller = new AbortController();
    const timer = window.setTimeout(async () => {
      setLoading(true);
      setError("");
      try {
        const response = await archiveFetch(`/api/sources?q=${encodeURIComponent(query.trim())}&limit=10&offset=${offset}`,
          { signal: controller.signal });
        if (response.status === 403) {
          if (!controller.signal.aborted) { setForbidden(true); setEntries([]); setTotal(0); }
          return;
        }
        const data = await response.json();
        if (!response.ok) throw new Error(data.error || "Каталог недоступен");
        if (controller.signal.aborted) return;
        const next = data.sources as CatalogEntry[];
        setEntries((current) => offset ? [...current, ...next] : next);
        setTotal(data.total as number);
      } catch (reason) {
        if (!controller.signal.aborted) setError((reason as Error).message);
      } finally {
        if (!controller.signal.aborted) setLoading(false);
      }
    }, 180);
    return () => { window.clearTimeout(timer); controller.abort(); };
  }, [open, query, offset, retry, forbidden]);

  if (forbidden) return <small role="alert">Доступ к каталогу источников изменился.</small>;
  return <div className="union-catalog-picker">
    <button type="button" aria-expanded={open} onClick={() => setOpen((value) => !value)}>
      {open ? "Закрыть каталог" : "Выбрать из каталога"}
    </button>
    {open && <div className="union-catalog-results">
      <label>Поиск источника
        <input value={query} maxLength={100} placeholder="Название или архив"
          onChange={(event) => { setQuery(event.target.value); setOffset(0); setEntries([]); }} />
      </label>
      {loading && <small role="status">Ищем источники…</small>}
      {error && <p role="alert">{error} <button type="button" onClick={() => setRetry((n) => n + 1)}>Повторить</button></p>}
      {!error && entries.map((source) => <button type="button" key={source.id}
        disabled={existing.some((item) => item.catalogId === source.id)}
        onClick={() => { onChoose(source); setOpen(false); }}>
        <strong>{source.title}</strong><small>{[source.archive, source.reference].filter(Boolean).join(" · ")}</small>
      </button>)}
      {!loading && !error && !entries.length && <small>Источники не найдены</small>}
      {entries.length < total && <button type="button" disabled={loading} onClick={() => setOffset(entries.length)}>Показать ещё</button>}
    </div>}
  </div>;
}

export function UnionSourcesEditor({ sources, onChange, isAdmin }: {
  sources: Source[];
  onChange: (sources: Source[]) => void;
  isAdmin: boolean;
}) {
  const remove = (index: number) => onChange(sources.filter((_, i) => i !== index));
  return <div className="union-sources-editor">
    {sources.map((source, index) => source.catalogId
      ? <div className="union-catalog-citation" key={`${source.catalogId}-${index}`}>
          <strong>{source.title}</strong><small>{source.reference}</small>
          <button type="button" onClick={() => remove(index)}>Убрать источник</button>
        </div>
      : <div className="union-inline-citation" key={index}>
          {(["title", "type", "reference", "url"] as const).map((field) =>
            <label key={field}>{({ title: "Название", type: "Тип", reference: "Ссылка в источнике", url: "URL" })[field]}
              <input value={source[field] || ""} onChange={(event) => onChange(sources.map((item, i) =>
                i === index ? { ...item, [field]: event.target.value } : item))} />
            </label>)}
          <button type="button" onClick={() => remove(index)}>Удалить источник</button>
        </div>)}
    <div className="union-source-actions">
      <button type="button" disabled={sources.length >= 50} onClick={() => onChange([...sources,
        { title: "", type: "", reference: "" }])}>Добавить источник вручную</button>
      {isAdmin && sources.length < 50 && <CatalogPicker existing={sources}
        onChoose={(entry) => onChange([...sources, sourceCitation(entry)])} />}
    </div>
  </div>;
}
