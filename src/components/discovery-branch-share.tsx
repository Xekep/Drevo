import { useState } from "react";
import { archiveFetch } from "../data/archive-fetch.ts";

type Member = { id: string; relation: "parent" | "child" | "spouse"; name: string;
  birthYear?: string; deathYear?: string; birthPlace?: string; deathPlace?: string };
type Detail = { available: Member[]; truncated: boolean; previewToken: string;
  ownReady: boolean; otherReady: boolean; outgoingIds: string[]; incoming: Member[] };
const relationLabels = { parent: "Родитель", child: "Ребёнок", spouse: "Супруг(а)" };

function MemberCard({ person, matchId, archiveId }: { person: Member; matchId: string;
  archiveId: string }) {
  return <li><strong>{relationLabels[person.relation]}: {person.name}</strong>
    {(person.birthYear || person.deathYear) && <small> · {person.birthYear || "?"}–{person.deathYear || "?"}</small>}
    {person.birthPlace && <small> · Рождение: {person.birthPlace}</small>}
    {person.deathPlace && <small> · Смерть: {person.deathPlace}</small>}
    <a href={`/discover/linked/${encodeURIComponent(archiveId)}/${encodeURIComponent(matchId)}/${encodeURIComponent(person.id)}`}>
      Открыть разрешённую карточку
    </a>
  </li>;
}

export function DiscoveryBranchShare({ matchId, archiveId }: { matchId: string; archiveId: string }) {
  const [detail, setDetail] = useState<Detail | null>(null);
  const [selected, setSelected] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const endpoint = `/api/discovery/matches/${matchId}/branch-share`;
  async function load(preserveError = false) {
    setBusy(true); if (!preserveError) setError("");
    try {
      const response = await archiveFetch(endpoint, { cache: "no-store" });
      const body = await response.json();
      if (!response.ok) throw new Error(body.error || "Не удалось проверить разрешение ветки");
      setDetail(body);
      setSelected(body.outgoingIds);
    } catch (reason) {
      setDetail(null); setSelected([]);
      setError((reason as Error).message);
    } finally { setBusy(false); }
  }
  async function save(method: "PUT" | "DELETE") {
    if (!detail) return;
    setBusy(true); setError(""); setNotice("");
    try {
      const response = await archiveFetch(endpoint, {
        method,
        ...(method === "PUT" ? { headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ personIds: selected, previewToken: detail.previewToken }) } : {}),
      });
      const body = await response.json();
      if (!response.ok) throw new Error(body.error || "Не удалось изменить разрешение");
      setNotice(method === "PUT" ? "Выбор сохранён. Просмотр откроется после разрешения второй стороны."
        : "Доступ к ветке отозван.");
      await load();
    } catch (reason) {
      await load();
      setError((reason as Error).message);
    } finally { setBusy(false); }
  }
  return <details className="match-card-share" onToggle={(event) => {
    if (event.currentTarget.open && !busy) void load();
    if (!event.currentTarget.open) { setDetail(null); setSelected([]); }
  }}>
    <summary>Поделиться разрешённой веткой</summary>
    <p>Каждый владелец выбирает своих опубликованных прямых родственников. Ветви видны только после разрешения обеих сторон; частные карточки, фото и документы не открываются. Любая правка своего дерева отзывает выданное разрешение: после неё выбор нужно подтвердить заново. Отзыв публикации сразу убирает карточку из ветки.</p>
    {busy && !detail && <p role="status">Проверяем…</p>}
    {detail && <>
      <h4>Ваши опубликованные родственники</h4>
      {detail.truncated && <p>Показаны первые 50 родственников. Этот просмотр ограничен ими.</p>}
      {!detail.available.length && <p>Опубликованных прямых родственников нет. Можно разрешить просмотр без добавления людей.</p>}
      {detail.available.map((person) => <label className="match-share-option" key={person.id}>
        <input type="checkbox" checked={selected.includes(person.id)} disabled={busy ||
          (!selected.includes(person.id) && selected.length >= 20)}
          onChange={(event) => setSelected((current) => event.target.checked
            ? [...current, person.id] : current.filter((id) => id !== person.id))} />
        <span>{relationLabels[person.relation]}: {person.name}</span>
      </label>)}
      <p>Можно выбрать до 20 человек. Согласие без выбранных людей позволяет видеть разрешённую ветку другой стороны.</p>
      <div className="match-request-actions">
        <button type="button" disabled={busy} onClick={() => void save("PUT")}>Разрешить выбранное</button>
        {detail.ownReady && <button type="button" disabled={busy}
          onClick={() => void save("DELETE")}>Отозвать доступ к ветке</button>}
        <button type="button" disabled={busy} onClick={() => void load()}>Обновить просмотр</button>
      </div>
      <p>{detail.ownReady ? "Ваше разрешение действует." : "Вы ещё не разрешили просмотр."} {detail.otherReady
        ? "Вторая сторона разрешила просмотр." : "Ожидаем разрешения второй стороны."}</p>
      <h4>Разрешённая ветка другого архива</h4>
      {detail.ownReady && detail.otherReady
        ? detail.incoming.length ? <ul>{detail.incoming.map((person) =>
          <MemberCard key={person.id} person={person} matchId={matchId} archiveId={archiveId} />)}</ul>
          : <p>Другая сторона не выбрала родственников.</p>
        : <p>Просмотр откроется после разрешения обеих сторон.</p>}
    </>}
    {error && <p role="alert" className="form-error">{error}</p>}
    {notice && <p role="status" className="admin-notice">{notice}</p>}
  </details>;
}
