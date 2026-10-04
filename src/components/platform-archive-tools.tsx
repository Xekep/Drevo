import { useEffect, useState } from "react";
import { archiveFetch } from "../data/archive-fetch.ts";
import { isArchiveOwner, type ArchiveUser } from "../domain/access.ts";
import { archiveResourceUrl } from "../domain/archive-context.ts";
import { BackupAdmin } from "./backup-admin";
import { McpTokenAdmin } from "./mcp-token-admin";

type OwnedArchive = { id: string; title: string; current: boolean };
type DirectoryArchive = OwnedArchive & { approved: boolean; owned: boolean };
type Access = {
  key: string;
  status: "ready" | "denied" | "error";
  ai: boolean;
  error?: string;
};

/** Archive tools live in the platform UI but retain their archive ownership boundary. */
export function PlatformArchiveTools({
  kind,
  accountId,
  primaryUser,
  local = false,
}: {
  kind: "mcp" | "backups";
  accountId: string;
  primaryUser?: ArchiveUser | null;
  local?: boolean;
}) {
  const [archives, setArchives] = useState<OwnedArchive[]>([]);
  const [selectedId, setSelectedId] = useState("");
  const [directoryReady, setDirectoryReady] = useState(false);
  const [directoryError, setDirectoryError] = useState("");
  const [access, setAccess] = useState<Access | null>(null);
  const [retry, setRetry] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    const load = async (): Promise<OwnedArchive[]> => {
      if (local && primaryUser?.approved && isArchiveOwner(primaryUser))
        return [{ id: "primary", title: "Основной архив", current: true }];
      const response = await archiveFetch("/api/account/archives", {
        cache: "no-store",
        signal: controller.signal,
      });
      if (
        response.status === 501 &&
        primaryUser?.approved &&
        isArchiveOwner(primaryUser)
      )
        return [{ id: "primary", title: "Основной архив", current: true }];
      const body = (await response.json()) as {
        archives?: DirectoryArchive[];
        error?: string;
      };
      if (!response.ok)
        throw new Error(body.error || "Не удалось загрузить архивы");
      return (body.archives || []).filter(
        (archive) => archive.approved && archive.owned,
      );
    };
    void load()
      .then((available) => {
        if (controller.signal.aborted) return;
        setArchives(available);
        setSelectedId((current) =>
          available.some((archive) => archive.id === current)
            ? current
            : available[0]?.id || "",
        );
        setDirectoryReady(true);
      })
      .catch((error: unknown) => {
        if (controller.signal.aborted) return;
        setDirectoryError(
          error instanceof Error
            ? error.message
            : "Не удалось загрузить архивы",
        );
        setDirectoryReady(true);
      });
    return () => controller.abort();
  }, [primaryUser, local, retry]);

  const selected = archives.find((archive) => archive.id === selectedId);
  const pathname = selected?.current ? "/" : `/a/${selectedId}`;
  const key = selected ? selectedId : "";
  useEffect(() => {
    if (!key) return;
    const controller = new AbortController();
    void archiveFetch(archiveResourceUrl("/api/session", pathname), {
      cache: "no-store",
      signal: controller.signal,
    })
      .then(async (response) => {
        const body = (await response.json()) as {
          local?: boolean;
          account?: { id: string; globalRole?: string };
          user?: ArchiveUser | null;
          error?: string;
        };
        if (!response.ok)
          throw new Error(body.error || "Не удалось проверить доступ к архиву");
        if (controller.signal.aborted) return;
        const actor = body.account || body.user;
        const admin =
          body.account?.globalRole === "admin" ||
          body.user?.platformAdmin === true;
        const allowed =
          actor?.id === accountId &&
          admin &&
          body.user?.approved === true &&
          isArchiveOwner(body.user);
        setAccess({
          key,
          status: allowed ? "ready" : "denied",
          ai: body.local === true || body.user?.aiAvailable === true,
        });
      })
      .catch((error: unknown) => {
        if (!controller.signal.aborted)
          setAccess({
            key,
            status: "error",
            ai: false,
            error:
              error instanceof Error
                ? error.message
                : "Не удалось проверить доступ к архиву",
          });
      });
    return () => controller.abort();
  }, [key, pathname, accountId, retry]);

  const currentAccess = access?.key === key ? access : null;
  const refresh = () => {
    setDirectoryError("");
    setDirectoryReady(false);
    setAccess(null);
    setRetry((value) => value + 1);
  };
  return (
    <div className="platform-archive-tools">
      <section className="account-card">
        <div className="account-card-title">
          <h2>{kind === "mcp" ? "MCP-токены" : "Резервные копии"}</h2>
        </div>
        {!directoryReady ? (
          <p role="status">Загружаем архивы…</p>
        ) : directoryError ? (
          <>
            <p role="alert" className="form-error">
              {directoryError}
            </p>
            <button type="button" onClick={refresh}>
              Повторить
            </button>
          </>
        ) : !selected ? (
          <p role="status">Нет доступных архивов для этой операции.</p>
        ) : (
          <label className="platform-archive-select">
            {kind === "mcp" ? "Архив для MCP" : "Архив для резервных копий"}
            <select
              value={selectedId}
              onChange={(event) => setSelectedId(event.target.value)}
            >
              {archives.map((archive) => (
                <option key={archive.id} value={archive.id}>
                  {archive.title}
                </option>
              ))}
            </select>
          </label>
        )}
      </section>
      {directoryReady &&
        !directoryError &&
        selected &&
        (!currentAccess ? (
          <p role="status">Проверяем доступ к архиву…</p>
        ) : currentAccess.status === "error" ? (
          <section className="account-card">
            <p role="alert" className="form-error">
              {currentAccess.error}
            </p>
            <button type="button" onClick={refresh}>
              Повторить
            </button>
          </section>
        ) : currentAccess.status === "denied" ? (
          <p role="status">Доступ к управлению этим архивом изменился.</p>
        ) : kind === "mcp" && !currentAccess.ai ? (
          <p role="status">ИИ-функции недоступны в выбранном архиве.</p>
        ) : kind === "mcp" ? (
          <McpTokenAdmin
            key={key}
            archiveId={selected.current ? null : selected.id}
          />
        ) : (
          <BackupAdmin
            key={key}
            archiveId={selected.current ? null : selected.id}
          />
        ))}
    </div>
  );
}
