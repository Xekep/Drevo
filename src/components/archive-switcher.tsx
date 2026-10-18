import { useEffect, useState, type MouseEvent } from "react";
import {
  ArrowRight,
  Check,
  LoaderCircle,
  Search,
  TriangleAlert,
} from "lucide-react";
import { archiveFetch } from "../data/archive-fetch.ts";
import { ROLE_NAMES, type Role } from "../domain/access";
import { EditorDialog } from "./editor-dialog";
import "../styles/account.css";

type AccessibleArchive = {
  id: string;
  title: string;
  current: boolean;
  owned: boolean;
  approved: boolean;
  role: Role;
  href?: string;
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
      <div className="archive-switcher-body">
        {error ? (
          <div className="archive-switcher-state" role="alert">
            <TriangleAlert size={18} aria-hidden="true" />
            <p>Не удалось загрузить древа.</p>
            <button
              type="button"
              className="archive-switcher-retry"
              onClick={() => {
                setError(false);
                setAttempt((value) => value + 1);
              }}
            >
              Повторить
            </button>
          </div>
        ) : !archives ? (
          <div className="archive-switcher-state" role="status">
            <LoaderCircle
              size={18}
              className="archive-switcher-spinner"
              aria-hidden="true"
            />
            <p>Загружаем древа…</p>
          </div>
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
            <ul className="archive-switcher-list" aria-label="Ваши древа">
              {filtered?.map((item) => {
                const content = (
                  <>
                    <span className="archive-switcher-name">
                      <strong>{item.title}</strong>
                      <small>
                        {item.owned ? "Ваше древо" : ROLE_NAMES[item.role]}
                      </small>
                    </span>
                    {item.current ? (
                      <span className="archive-switcher-current">
                        <Check size={14} aria-hidden="true" />
                        Открыто
                      </span>
                    ) : item.approved ? (
                      <ArrowRight
                        size={18}
                        className="archive-switcher-arrow"
                        aria-hidden="true"
                      />
                    ) : (
                      <span className="archive-switcher-pending">
                        Ожидает доступа
                      </span>
                    )}
                  </>
                );
                return (
                  <li
                    key={item.id}
                    aria-current={item.current ? "true" : undefined}
                  >
                    {item.approved && !item.current ? (
                      <a
                        className="archive-switcher-row"
                        // Compatibility with an older API; remove after the next release.
                        href={item.href || `/a/${encodeURIComponent(item.id)}/tree`}
                        title={item.title}
                        onClick={leave}
                      >
                        {content}
                      </a>
                    ) : (
                      <div
                        className={`archive-switcher-row${item.current ? " is-current" : " is-pending"}`}
                        title={item.title}
                      >
                        {content}
                      </div>
                    )}
                  </li>
                );
              })}
            </ul>
            {!filtered?.length && (
              <p className="archive-switcher-empty" role="status">
                {query.trim()
                  ? "Древа не найдены."
                  : "Пока нет доступных древ."}
              </p>
            )}
          </>
        )}
      </div>
    </EditorDialog>
  );
}
