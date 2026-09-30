import { useEffect, useState } from "react";
import { archiveFetch } from "../data/archive-fetch.ts";

type TransferStatus = {
  owner: boolean;
  incoming: { fromName: string; expiresAt: number } | null;
  outgoing: { targetId: string; targetName: string; expiresAt: number } | null;
};
type Candidate = {
  id: string;
  name: string;
  role: string;
  eligible: boolean;
};

async function responseJson<T>(response: Response): Promise<T> {
  const data = await response.json();
  if (!response.ok)
    throw new Error(data.error || "Не удалось обновить владение деревом");
  return data as T;
}

export function AccountOwnerTransfer() {
  const [status, setStatus] = useState<TransferStatus | null>(null);
  const [expanded, setExpanded] = useState(false);
  const [query, setQuery] = useState("");
  const [candidates, setCandidates] = useState<Candidate[]>([]);
  const [loadingCandidates, setLoadingCandidates] = useState(false);
  const [selected, setSelected] = useState<Candidate | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    const controller = new AbortController();
    void archiveFetch("/api/account/owner-transfer", {
      signal: controller.signal,
    })
      .then(responseJson<TransferStatus>)
      .then(setStatus)
      .catch((cause) => {
        if (!controller.signal.aborted) setError((cause as Error).message);
      });
    return () => controller.abort();
  }, []);

  useEffect(() => {
    if (!expanded || !status?.owner || status.outgoing) return;
    const controller = new AbortController();
    const timer = window.setTimeout(() => {
      void archiveFetch(
        `/api/account/owner-transfer/candidates?q=${encodeURIComponent(query)}`,
        { signal: controller.signal },
      )
        .then(responseJson<Candidate[]>)
        .then((result) => {
          setCandidates(result);
          setLoadingCandidates(false);
        })
        .catch((cause) => {
          if (!controller.signal.aborted) {
            setError((cause as Error).message);
            setLoadingCandidates(false);
          }
        });
    }, 200);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [expanded, query, status]);

  async function mutate(
    method: "POST" | "DELETE",
    path: string,
    body?: unknown,
  ) {
    setBusy(true);
    setError("");
    try {
      await responseJson(
        await archiveFetch(path, {
          method,
          headers: {
            "X-Drevo-Owner-Transfer": "1",
            ...(body ? { "Content-Type": "application/json" } : {}),
          },
          body: body ? JSON.stringify(body) : undefined,
        }),
      );
      if (path.endsWith("/accept")) {
        window.location.reload();
        return;
      }
      setStatus(
        await responseJson<TransferStatus>(
          await archiveFetch("/api/account/owner-transfer"),
        ),
      );
      setSelected(null);
      setExpanded(false);
    } catch (cause) {
      setError((cause as Error).message);
    } finally {
      setBusy(false);
    }
  }

  if (!status && !error) return null;
  if (status && !status.owner && !status.incoming) return null;
  return (
    <div className="account-owner-transfer">
      <strong>Владение деревом</strong>
      {status?.incoming && (
        <div className="account-owner-transfer-pending">
          <p>
            {status.incoming.fromName} предлагает вам стать владельцем этого
            дерева. После принятия он останется участником без прав управления.
          </p>
          <div className="account-owner-transfer-actions">
            <button
              type="button"
              disabled={busy}
              onClick={() =>
                void mutate("POST", "/api/account/owner-transfer/accept")
              }
            >
              Принять владение
            </button>
            <button
              type="button"
              disabled={busy}
              onClick={() =>
                void mutate("DELETE", "/api/account/owner-transfer")
              }
            >
              Отклонить
            </button>
          </div>
        </div>
      )}
      {status?.outgoing && (
        <div className="account-owner-transfer-pending">
          <p>
            Ожидаем согласия: {status.outgoing.targetName}. Предложение
            действует до{" "}
            {new Date(status.outgoing.expiresAt).toLocaleDateString("ru-RU")}.
          </p>
          <button
            type="button"
            disabled={busy}
            onClick={() => void mutate("DELETE", "/api/account/owner-transfer")}
          >
            Отозвать предложение
          </button>
        </div>
      )}
      {status?.owner && !status.outgoing && (
        <>
          {!expanded ? (
            <button
              type="button"
              onClick={() => {
                setLoadingCandidates(true);
                setExpanded(true);
              }}
            >
              Передать владение
            </button>
          ) : (
            <div className="account-owner-transfer-form">
              <p>
                Получатель должен уже участвовать в этом дереве и подтвердить
                передачу. Вы останетесь участником без прав управления.
              </p>
              <label>
                Найти участника
                <input
                  type="search"
                  value={query}
                  onChange={(event) => {
                    setQuery(event.target.value);
                    setSelected(null);
                    setCandidates([]);
                    setLoadingCandidates(true);
                  }}
                  placeholder="Имя участника"
                />
              </label>
              <div className="account-owner-transfer-candidates">
                {loadingCandidates && <p>Ищем участников…</p>}
                {!loadingCandidates && !candidates.length && (
                  <p>
                    Подходящих участников нет. Сначала пригласите человека в
                    дерево.
                  </p>
                )}
                {candidates.map((candidate) => (
                  <button
                    type="button"
                    key={candidate.id}
                    disabled={!candidate.eligible || busy}
                    aria-pressed={selected?.id === candidate.id}
                    onClick={() => setSelected(candidate)}
                  >
                    {candidate.name}
                    {!candidate.eligible && " · уже владеет деревом"}
                  </button>
                ))}
              </div>
              {selected && (
                <p className="account-owner-transfer-selection">
                  Получатель: <strong>{selected.name}</strong>
                </p>
              )}
              <div className="account-owner-transfer-actions">
                <button
                  type="button"
                  disabled={!selected || busy}
                  onClick={() =>
                    void mutate("POST", "/api/account/owner-transfer", {
                      targetId: selected?.id,
                    })
                  }
                >
                  Предложить передачу
                </button>
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => setExpanded(false)}
                >
                  Отмена
                </button>
              </div>
            </div>
          )}
        </>
      )}
      {error && (
        <p className="account-error" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}
