import { useEffect, useState } from "react";
import { EditorDialog } from "./editor-dialog";
import type {
  PlatformAccount,
  PlatformAccountStatistics,
} from "../shared/platform-accounts";

type Usage = {
  owned: boolean;
  people: number | null;
  mediaBytes: number | null;
};
export function PlatformAccountStatisticsDialog({
  account,
  onClose,
}: {
  account: PlatformAccount | null;
  onClose: () => void;
}) {
  const [data, setData] = useState<PlatformAccountStatistics | Usage | null>(
    null,
  );
  const [error, setError] = useState("");
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    void fetch(
      account
        ? `/api/platform/tiers/${encodeURIComponent(account.id)}/usage`
        : "/api/platform/accounts/statistics",
      { signal: controller.signal, cache: "no-store" },
    )
      .then(async (response) => {
        const body = await response.json();
        if (!response.ok)
          throw new Error(body.error || "Не удалось загрузить статистику.");
        if (!controller.signal.aborted) setData(body);
      })
      .catch((reason) => {
        if (!controller.signal.aborted) setError(reason.message);
      });
    return () => controller.abort();
  }, [account, attempt]);
  return (
    <EditorDialog
      title={account ? `Расход: ${account.name}` : "Статистика пользователей"}
      onClose={onClose}
      dismissOnOutside
      className="platform-account-statistics"
    >
      <div className="platform-statistics-body">
        {error ? (
          <p className="form-error" role="alert">
            {error} Проверьте соединение и повторите попытку.
            <button
              type="button"
              className="platform-directory-button"
              onClick={() => {
                setError("");
                setAttempt((value) => value + 1);
              }}
            >
              Повторить загрузку
            </button>
          </p>
        ) : !data ? (
          <p role="status">Загружаем статистику…</p>
        ) : "accounts" in data ? (
          <dl className="platform-statistics-grid">
            {[
              ["Всего пользователей", data.accounts],
              ["Базовые возможности", data.basic],
              ["Расширенные возможности", data.full],
              ["Администраторы", data.admins],
              ["Исследователи", data.researchers],
            ].map(([label, value]) => (
              <div key={label}>
                <dt>{label}</dt>
                <dd>{value}</dd>
              </div>
            ))}
          </dl>
        ) : data.owned ? (
          <dl className="platform-statistics-grid">
            <div>
              <dt>Людей</dt>
              <dd>{data.people ?? "Неизвестно"}</dd>
            </div>
            <div>
              <dt>Оригиналы файлов</dt>
              <dd>
                {data.mediaBytes === null
                  ? "Не подтверждено"
                  : `${new Intl.NumberFormat("ru-RU", { maximumFractionDigits: 1 }).format(data.mediaBytes / 1_000_000)} МБ`}
              </dd>
            </div>
          </dl>
        ) : (
          <p>Своё древо ещё не создано; расход неизвестен.</p>
        )}
      </div>
    </EditorDialog>
  );
}
