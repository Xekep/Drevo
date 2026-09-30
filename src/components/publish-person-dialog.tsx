import { archiveFetch } from "../data/archive-fetch.ts";
import { useEffect, useState } from "react";
import type { Person } from "../domain/types";
import { EditorDialog } from "./editor-dialog";

type Status = {
  archiveId?: string | null;
  published: boolean;
  publishable: boolean;
  person: {
    name: string;
    birthYear?: string;
    deathYear?: string;
    birthPlace?: string;
    deathPlace?: string;
  };
};

export function PublishPersonDialog({
  person,
  onClose,
}: {
  person: Person;
  onClose: () => void;
}) {
  const [status, setStatus] = useState<Status | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const endpoint = `/api/admin/published-people/${encodeURIComponent(person.id)}`;
  useEffect(() => {
    const controller = new AbortController();
    archiveFetch(endpoint, { signal: controller.signal, cache: "no-store" })
      .then(async (response) => {
        const data = await response.json();
        if (!response.ok) throw new Error(data.error);
        setStatus(data);
      })
      .catch((reason) => {
        if (!controller.signal.aborted)
          setError(reason.message || "Не удалось загрузить публикацию");
      });
    return () => controller.abort();
  }, [endpoint]);
  async function update(publish: boolean) {
    setBusy(true);
    setError("");
    try {
      const response = await archiveFetch(endpoint, {
        method: publish ? "PUT" : "DELETE",
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error);
      setStatus(data);
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
        <p>
          В поиске видны только ФИО, годы и места рождения/смерти. Родственные
          связи, фото и документы не раскрываются.
        </p>
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
            <button
              type="button"
              disabled={busy}
              onClick={() => update(!status.published)}
            >
              {status.published ? "Снять с поиска" : "Опубликовать в поиске"}
            </button>
          </div>
        )}
      </div>
    </EditorDialog>
  );
}
