import { archiveFetch } from "../data/archive-fetch.ts";
import { useEffect, useState } from "react";
import type { Person } from "../domain/types";
import { defaultPublicationFields, type PublicationFields } from "../shared/publication";
import { EditorDialog } from "./editor-dialog";

type Status = {
  archiveId?: string | null;
  published: boolean;
  publishable: boolean;
  fields: PublicationFields;
  person: {
    name: string;
    birthYear?: string;
    deathYear?: string;
    birthPlace?: string;
    deathPlace?: string;
  };
};
type RelativeConsent = { relationId: string; personId: string; name: string;
  kind: "parent" | "child" | "spouse"; enabled: boolean };

export function PublishPersonDialog({
  person,
  onClose,
  onStatus,
}: {
  person: Person;
  onClose: () => void;
  onStatus: (published: boolean) => void;
}) {
  const [status, setStatus] = useState<Status | null>(null);
  const [fields, setFields] = useState<PublicationFields>(defaultPublicationFields);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [relatives, setRelatives] = useState<RelativeConsent[]>([]);
  const endpoint = `/api/admin/published-people/${encodeURIComponent(person.id)}`;
  const relativeEndpoint = `/api/discovery/matches/relative-consents?personId=${encodeURIComponent(person.id)}`;
  useEffect(() => {
    const controller = new AbortController();
    archiveFetch(endpoint, { signal: controller.signal, cache: "no-store" })
      .then(async (response) => {
        const data = await response.json();
        if (!response.ok) throw new Error(data.error);
        setStatus(data);
        onStatus(data.published);
        setFields({
          birthSurname: data.fields.birthSurname && Boolean(person.maidenName),
          birthYear: data.fields.birthYear && Boolean(person.birth?.match(/\b\d{4}\b/)),
          deathYear: data.fields.deathYear && Boolean(person.death?.match(/\b\d{4}\b/)),
          birthPlace: data.fields.birthPlace && Boolean(person.birthPlace),
          deathPlace: data.fields.deathPlace && Boolean(person.deathPlace),
        });
      })
      .catch((reason) => {
        if (!controller.signal.aborted)
          setError(reason.message || "Не удалось загрузить публикацию");
      });
    return () => controller.abort();
  }, [endpoint, person.maidenName, person.birth, person.death, person.birthPlace, person.deathPlace, onStatus]);
  useEffect(() => {
    if (!status?.published || !status.archiveId) return;
    const controller = new AbortController();
    archiveFetch(relativeEndpoint, { signal: controller.signal, cache: "no-store" })
      .then(async (response) => {
        const data = await response.json();
        if (!response.ok) throw new Error(data.error);
        setRelatives(data.relatives);
      }).catch((reason) => {
        if (!controller.signal.aborted) setError(reason.message || "Не удалось загрузить связи");
      });
    return () => controller.abort();
  }, [relativeEndpoint, status?.published, status?.archiveId]);
  async function updateRelative(relative: RelativeConsent) {
    setBusy(true);
    setError("");
    try {
      const response = await archiveFetch("/api/discovery/matches/relative-consents", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ personId: person.id, relationId: relative.relationId,
          enabled: !relative.enabled }),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error);
      setRelatives((current) => current.map((item) => item.relationId === relative.relationId
        ? { ...item, enabled: !relative.enabled } : item));
    } catch (reason) {
      setError((reason as Error).message || "Не удалось изменить согласие");
    } finally { setBusy(false); }
  }
  async function update(publish: boolean) {
    setBusy(true);
    setError("");
    try {
      const response = await archiveFetch(endpoint, {
        method: publish ? "PUT" : "DELETE",
        ...(publish ? { headers: { "Content-Type": "application/json" }, body: JSON.stringify({ fields }) } : {}),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error);
      if (data.saved === true && data.refreshRequired === true) {
        setStatus(null);
        setError("Изменение сохранено, но доступ к архиву мог измениться. Обновите архив.");
        return;
      }
      setStatus(data);
      setFields(data.fields);
      onStatus(data.published);
    } catch (reason) {
      setError((reason as Error).message || "Не удалось изменить публикацию");
    } finally {
      setBusy(false);
    }
  }
  const link = new URL(
    `/discover/person/${status?.archiveId ? `${encodeURIComponent(status.archiveId)}/` : ""}${encodeURIComponent(person.id)}`,
    location.origin,
  ).href;
  const possibleFields = [
    { key: "birthSurname", label: "Фамилия при рождении", value: person.maidenName },
    { key: "birthYear", label: "Год рождения", value: person.birth?.match(/\b\d{4}\b/)?.[0] },
    { key: "deathYear", label: "Год смерти", value: person.death?.match(/\b\d{4}\b/)?.[0] },
    { key: "birthPlace", label: "Место рождения", value: person.birthPlace },
    { key: "deathPlace", label: "Место смерти", value: person.deathPlace },
  ] as const;
  const changed = status && possibleFields.some(({ key }) => fields[key] !== status.fields[key]);
  return (
    <EditorDialog title="Публикация человека в поиске" onClose={onClose}>
      <div className="archive-form">
        <p>
          После публикации вошедшие пользователи смогут найти эту карточку без
          доступа к древу.
        </p>
        <p>
          <strong>
            {status?.person.name || `${person.surname} ${person.name}`}
          </strong>
        </p>
        <fieldset disabled={busy || !status?.publishable}>
          <legend>Что будет видно в поиске</legend>
          <p>ФИО — обязательно. Остальные поля выбираются отдельно.</p>
          {possibleFields.map(({ key, label, value }) => value ? (
            <label key={key} className="publication-field">
              <input type="checkbox" checked={fields[key]}
                onChange={(event) => setFields((current) => ({ ...current, [key]: event.target.checked }))} />
              <span>{label}: {value}</span>
            </label>
          ) : null)}
        </fieldset>
        <p>Фото и документы не раскрываются. Близкие родственные связи открываются отдельно.</p>
        {status?.published && status.archiveId && relatives.length > 0 && <fieldset disabled={busy}>
          <legend>Близкие родственники в поиске</legend>
          <p>Каждую связь можно разрешить и отозвать отдельно. Обе карточки уже опубликованы.</p>
          {relatives.map((relative) => <label key={relative.relationId} className="publication-field">
            <input type="checkbox" checked={relative.enabled}
              onChange={() => void updateRelative(relative)} />
            <span>{relative.kind === "parent" ? "Родитель" : relative.kind === "child"
              ? "Ребёнок" : "Супруг(а)"}: {relative.name}</span>
          </label>)}
        </fieldset>}
        {status && !status.publishable && (
          <p>
            Опубликовать можно только человека, для которого подтверждена
            смерть. Если карточка уже была опубликована, снимите её с поиска.
          </p>
        )}
        {status?.published && status.publishable && (
          <p>
            Ссылка:{" "}
            <a href={link} target="_blank" rel="noreferrer">
              {link}
            </a>
          </p>
        )}
        {error && <p role="alert">{error}</p>}
        {!status && !error && <p role="status">Загружаем статус…</p>}
        {status && (status.published || status.publishable) && (
          <div className="form-actions">
            {status.publishable && (!status.published || changed) && <button
              type="button"
              disabled={busy}
              onClick={() => update(true)}
            >
              {status.published ? "Сохранить видимые поля" : "Опубликовать в поиске"}
            </button>}
            {status.published && <button type="button" disabled={busy} onClick={() => update(false)}>
              Снять с поиска
            </button>}
          </div>
        )}
      </div>
    </EditorDialog>
  );
}
