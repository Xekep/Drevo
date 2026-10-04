import { useCallback, useEffect, useRef, useState } from "react";
import { archiveFetch } from "../data/archive-fetch.ts";
import { discoveryBranchRelationLabels as relationLabels,
  type DiscoveryBranchRelation } from "../shared/discovery-branch.ts";

type Member = { id: string; relation: DiscoveryBranchRelation; name: string;
  birthYear?: string; deathYear?: string; birthPlace?: string; deathPlace?: string;
  viaIds?: string[]; viaId?: string; previewToken?: string };
type Detail = { available: Member[]; truncated: boolean; previewToken: string;
  ownReady: boolean; otherReady: boolean; outgoingIds: string[]; incoming: Member[];
  recipientArchiveId: string; recipientPersonName: string; ownExpiresAt: string | null };
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
  const panel = useRef<HTMLDetailsElement>(null);
  const request = useRef<AbortController | null>(null);
  const requestVersion = useRef(0);
  const [detail, setDetail] = useState<Detail | null>(null);
  const [selected, setSelected] = useState<string[]>([]);
  const [durationDays, setDurationDays] = useState(7);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [expandingViaId, setExpandingViaId] = useState<string | null>(null);
  const [expansionOptions, setExpansionOptions] = useState<Member[]>([]);
  const [expansionCursor, setExpansionCursor] = useState<string | null>(null);
  const [expansionBusy, setExpansionBusy] = useState(false);
  const endpoint = `/api/discovery/matches/${matchId}/branch-share`;
  const available = detail?.available || [];
  const chosenViaName = (person: Member) => available.find((item) =>
    person.viaIds?.includes(item.id) && selected.includes(item.id))?.name;
  const cancelRead = useCallback(() => {
    requestVersion.current++;
    request.current?.abort();
    request.current = null;
  }, []);
  const load = useCallback(async (preserveError = false) => {
    request.current?.abort();
    const controller = new AbortController();
    request.current = controller;
    const version = ++requestVersion.current;
    setDetail(null); setSelected([]); setExpandingViaId(null); setExpansionOptions([]);
    setExpansionCursor(null);
    setBusy(true); if (!preserveError) setError("");
    try {
      const response = await archiveFetch(endpoint, { cache: "no-store", signal: controller.signal });
      const body = await response.json();
      if (controller.signal.aborted || version !== requestVersion.current) return;
      if (!response.ok) throw new Error(body.error || "Не удалось проверить разрешение ветки");
      setDetail(body);
      setSelected(body.outgoingIds);
    } catch (reason) {
      if (controller.signal.aborted || version !== requestVersion.current) return;
      setDetail(null); setSelected([]);
      setError((reason as Error).message);
    } finally {
      if (version === requestVersion.current) { request.current = null; setBusy(false); }
    }
  }, [endpoint]);
  useEffect(() => {
    if (panel.current?.open) void load();
    return cancelRead;
  }, [load, cancelRead]);
  async function save(method: "PUT" | "DELETE") {
    if (!detail) return;
    const version = requestVersion.current;
    setBusy(true); setError(""); setNotice("");
    try {
      const response = await archiveFetch(endpoint, {
        method,
        ...(method === "PUT" ? { headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ personIds: selected, previewToken: detail.previewToken,
            recipientArchiveId: detail.recipientArchiveId, durationDays }) } : {}),
      });
      const body = await response.json();
      if (version !== requestVersion.current || !panel.current?.open) return;
      if (!response.ok) throw new Error(body.error || "Не удалось изменить разрешение");
      setNotice(method === "PUT" ? "Выбор сохранён. Просмотр откроется после разрешения второй стороны."
        : "Доступ к ветке отозван.");
      await load();
    } catch (reason) {
      if (version !== requestVersion.current || !panel.current?.open) return;
      setError((reason as Error).message);
      await load(true);
    } finally { if (version === requestVersion.current) setBusy(false); }
  }
  async function showNext(viaId: string, after?: string) {
    setExpansionBusy(true); setError("");
    try {
      const path = `${endpoint}/options/${encodeURIComponent(viaId)}`;
      const response = await archiveFetch(after ? `${path}?after=${encodeURIComponent(after)}` : path,
        { cache: "no-store" });
      const body = await response.json();
      if (!response.ok) throw new Error(body.error || "Не удалось проверить продолжение ветки");
      setExpandingViaId(viaId);
      setExpansionOptions((current) => after ? [...current,...body.options] : body.options);
      setExpansionCursor(body.nextCursor);
    } catch (reason) { setError((reason as Error).message); }
    finally { setExpansionBusy(false); }
  }
  async function addNext(person: Member) {
    if (!expandingViaId || !person.previewToken) return;
    setExpansionBusy(true); setError("");
    try {
      const response = await archiveFetch(`${endpoint}/options/${encodeURIComponent(expandingViaId)}`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ personId: person.id, previewToken: person.previewToken }),
      });
      const body = await response.json();
      if (!response.ok) throw new Error(body.error || "Ветка изменилась. Обновите продолжение");
      setNotice("Карточка добавлена в ваш явный выбор. Она станет видна после разрешения другой стороны.");
      await load();
    } catch (reason) { setError((reason as Error).message); }
    finally { setExpansionBusy(false); }
  }
  return <details ref={panel} className="match-card-share" onToggle={(event) => {
    if (event.currentTarget.open) { setNotice(""); void load(); }
    else {
      cancelRead();
      setDetail(null); setSelected([]); setBusy(false);
    }
  }}>
    <summary>Поделиться разрешённой веткой</summary>
    <p>Каждый владелец явно выбирает опубликованных родственников. Сначала сохраните ближайших людей; затем можно добавить соседнюю опубликованную карточку по одному шагу от уже выбранного человека, всего до 20 карточек. Ветви видны только после разрешения обеих сторон; частные карточки, фото и документы не открываются. Любая правка своего дерева отзывает выданное разрешение: после неё выбор нужно подтвердить заново. Отзыв публикации промежуточного человека убирает и зависимую карточку.</p>
    {busy && !detail && <p role="status">Проверяем…</p>}
    {detail && <>
      <p>Адресат: опубликованная карточка «{detail.recipientPersonName}», архив <code
        style={{ overflowWrap: "anywhere" }}>{detail.recipientArchiveId}</code>. Доступ только для владельца этого архива и только в данной подтверждённой связи.</p>
      <h4>Ваши опубликованные родственники</h4>
      {detail.truncated && <p>Показаны первые 50 родственников. Этот просмотр ограничен ими.</p>}
      {!detail.available.length && <p>Опубликованных родственников в этой ветке нет. Можно разрешить просмотр без добавления людей.</p>}
      {detail.available.map((person) => <label className="match-share-option" key={person.id}>
        <input type="checkbox" checked={selected.includes(person.id)} disabled={busy ||
          (!selected.includes(person.id) && (selected.length >= 20 ||
            (Boolean(person.viaIds?.length) && !person.viaIds?.some((id) => selected.includes(id)))))}
          onChange={(event) => setSelected((current) => {
            if (event.target.checked) return [...current, person.id];
            const remaining = new Set(current.filter((id) => id !== person.id));
            let changed = true;
            while (changed) {
              changed = false;
              for (const id of [...remaining]) {
                const choice = available.find((item) => item.id === id);
                if (choice?.viaIds?.length && !choice.viaIds.some((viaId) => remaining.has(viaId))) {
                  remaining.delete(id);
                  changed = true;
                }
              }
            }
            return [...remaining];
          })} />
        <span>{relationLabels[person.relation]}: {person.name}
          {chosenViaName(person) && <small> · через {chosenViaName(person)}</small>}</span>
      </label>)}
      {detail.ownReady && detail.outgoingIds.length > 0 && <div className="match-branch-expansion">
        <h4>Продолжить выбранную ветку</h4>
        <p>Каждый следующий шаг выбирается отдельно. Показаны только опубликованные соседние карточки вашего архива.</p>
        {detail.outgoingIds.map((id) => {
          const person = available.find((item) => item.id === id);
          return person && <button key={id} type="button" disabled={busy || expansionBusy ||
            detail.outgoingIds.length >= 20} onClick={() => void showNext(id)}>
            Дальше от «{person.name}»
          </button>;
        })}
        {expandingViaId && <div>
          <p>Следующий опубликованный шаг от «{available.find((item) =>
            item.id === expandingViaId)?.name || "выбранной карточки"}»:</p>
          {!expansionOptions.length && !expansionBusy && <p>Доступных соседних карточек нет.</p>}
          {expansionOptions.map((person) => <div key={person.id}>
            <span>{person.name}</span>{person.birthYear && <small> · {person.birthYear}</small>}
            <button type="button" disabled={busy || expansionBusy}
              onClick={() => void addNext(person)}>Добавить эту карточку</button>
          </div>)}
          {expansionCursor && <button type="button" disabled={busy || expansionBusy}
            onClick={() => void showNext(expandingViaId,expansionCursor)}>Показать ещё</button>}
        </div>}
      </div>}
      <p>Можно выбрать до 20 человек. Согласие без выбранных людей позволяет видеть разрешённую ветку другой стороны.</p>
      <label>Срок нового разрешения <select value={durationDays} disabled={busy}
        onChange={(event) => setDurationDays(Number(event.target.value))}>
        <option value={1}>1 день</option><option value={7}>7 дней</option>
        <option value={30}>30 дней</option>
      </select></label>
      <div className="match-request-actions">
        <button type="button" disabled={busy} onClick={() => void save("PUT")}>Разрешить выбранное</button>
        {detail.ownReady && <button type="button" disabled={busy}
          onClick={() => void save("DELETE")}>Отозвать доступ к ветке</button>}
        <button type="button" disabled={busy} onClick={() => void load()}>Обновить просмотр</button>
      </div>
      <p>{detail.ownReady
        ? detail.ownExpiresAt
          ? `Ваше разрешение действует до ${new Date(detail.ownExpiresAt).toLocaleString("ru-RU")}.`
          : "Ваше прежнее разрешение действует до отзыва."
        : "Вы ещё не разрешили просмотр."} {detail.otherReady
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
