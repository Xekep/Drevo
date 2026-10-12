import { useEffect, useState } from "react";
import { archiveFetch } from "../data/archive-fetch.ts";
import type { AuditActorPage } from "../shared/audit-actors.ts";

/** Authors come from the journal, including former members, independently of its current page. */
export function AuditActorFilter({
  value,
  onChange,
}: {
  value: string;
  onChange: (id: string) => void;
}) {
  const [cursors, setCursors] = useState([0]);
  const before = cursors.at(-1)!;
  const [page, setPage] = useState<{
    key: number;
    result: AuditActorPage;
  } | null>(null);
  const [error, setError] = useState("");
  const [attempt, setAttempt] = useState(0);
  const [selected, setSelected] = useState<{ id: string; name: string } | null>(
    null,
  );
  const current = page?.key === before ? page.result : null;
  useEffect(() => {
    const controller = new AbortController();
    void archiveFetch(`/api/audit/actors?before=${before}`, {
      signal: controller.signal,
    })
      .then(async (response) => {
        if (!response.ok)
          throw new Error("Не удалось загрузить авторов журнала");
        const result = (await response.json()) as AuditActorPage;
        if (!controller.signal.aborted) setPage({ key: before, result });
      })
      .catch(() => {
        if (!controller.signal.aborted)
          setError(
            "Не удалось загрузить авторов. Проверьте соединение и повторите попытку.",
          );
      });
    return () => controller.abort();
  }, [before, attempt]);
  return (
    <div className="audit-actor-filter">
      <label htmlFor="audit-actor">Кто изменил</label>
      <select
        id="audit-actor"
        value={value}
        onChange={(event) => {
          const id = event.target.value;
          setSelected(current?.actors.find((actor) => actor.id === id) || null);
          onChange(id);
        }}
      >
        <option value="">Все участники</option>
        <option value="system">Система</option>
        {selected &&
          !current?.actors.some((actor) => actor.id === selected.id) && (
            <option value={selected.id}>{selected.name}</option>
          )}
        {current?.actors.map((actor) => (
          <option key={actor.id} value={actor.id}>
            {actor.name}
          </option>
        ))}
      </select>
      {!current && !error && <span role="status">Загружаем авторов…</span>}
      {error && (
        <p role="alert">
          {error}{" "}
          <button
            type="button"
            onClick={() => {
              setError("");
              setAttempt((old) => old + 1);
            }}
          >
            Повторить
          </button>
        </p>
      )}
      {(cursors.length > 1 || current?.next) && (
        <nav aria-label="Страницы авторов журнала">
          <button
            type="button"
            disabled={cursors.length === 1}
            onClick={() => {
              setError("");
              setCursors((old) => old.slice(0, -1));
            }}
          >
            Предыдущие авторы
          </button>
          <button
            type="button"
            disabled={!current?.next}
            onClick={() => {
              setError("");
              setCursors((old) => [...old, current!.next!]);
            }}
          >
            Другие авторы
          </button>
        </nav>
      )}
    </div>
  );
}
