import { useEffect, useState, type MouseEvent } from "react";
import { ArrowRight, Search } from "lucide-react";
import { archiveFetch } from "../data/archive-fetch.ts";
import { EditorDialog } from "./editor-dialog";
import "../styles/account.css";

type AccessibleArchive = {
  id: string;
  title: string;
  current: boolean;
  owned: boolean;
  approved: boolean;
};
export function ArchiveSwitcher({
  onClose,
  beforeLeave,
}: {
  onClose: () => void;
  beforeLeave?: () => boolean;
}) {
  const [archives, setArchives] = useState<AccessibleArchive[] | null>(null);
  const [query, setQuery] = useState("");
  const [error, setError] = useState(false);
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    void archiveFetch("/api/account/archives", {
      cache: "no-store",
      signal: controller.signal,
    })
      .then(async (response) => {
        if (!response.ok) throw new Error("Archive directory unavailable");
        const data = (await response.json()) as {
          archives?: AccessibleArchive[];
        };
        if (!Array.isArray(data.archives))
          throw new Error("Invalid archive directory");
        if (!controller.signal.aborted) setArchives(data.archives);
      })
      .catch(() => {
        if (!controller.signal.aborted) setError(true);
      });
    return () => controller.abort();
  }, [attempt]);
  const leave = (event: MouseEvent<HTMLAnchorElement>) => {
    if (
      event.button === 0 &&
      !event.ctrlKey &&
      !event.metaKey &&
      !event.shiftKey &&
      !event.altKey &&
      beforeLeave &&
      !beforeLeave()
    )
      event.preventDefault();
  };
  const filtered = archives?.filter((item) =>
    item.title
      .toLocaleLowerCase("ru")
      .includes(query.trim().toLocaleLowerCase("ru")),
  );
  return (
    <EditorDialog
      title="Доступные древа"
      onClose={onClose}
      dismissOnOutside
      className="archive-switcher"
    >
      {error ? (
        <div role="alert">
          Не удалось загрузить древа.{" "}
          <button
            type="button"
            onClick={() => { setError(false); setAttempt((value) => value + 1); }}
          >
            Повторить
          </button>
        </div>
      ) : !archives ? (
        <p role="status">Загрузка…</p>
      ) : (
        <>
          {archives.length > 5 && (
            <label className="archive-switcher-search">
              <Search size={18} aria-hidden="true" />
              <input
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder="Найти древо"
                aria-label="Найти древо"
              />
            </label>
          )}
          <div className="account-archive-list">
            {filtered?.map((item) => (
              <div className="account-archive-row" key={item.id}>
                <span className="account-archive-name">
                  <strong>{item.title}</strong>
                  <small>
                    {item.owned ? "Ваше древо" : "Вам предоставлен доступ"}
                  </small>
                </span>
                {item.current ? (
                  <span className="account-archive-current">Открыто</span>
                ) : item.approved ? (
                  <a
                    href={`/a/${encodeURIComponent(item.id)}/tree`}
                    onClick={leave}
                  >
                    Открыть <ArrowRight size={15} aria-hidden="true" />
                  </a>
                ) : (
                  <span className="account-archive-current">
                    Ожидает доступа
                  </span>
                )}
              </div>
            ))}
            {!filtered?.length && <p>Древа не найдены.</p>}
          </div>
        </>
      )}
    </EditorDialog>
  );
}
