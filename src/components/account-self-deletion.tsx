import { useState } from "react";
import { clearLayoutStorage } from "./tree/layout-storage";

type DeletionPlan = {
  name: string;
  ownedArchives: number;
  sharedArchives: number;
};

export function AccountSelfDeletion() {
  const [open, setOpen] = useState(false);
  const [plan, setPlan] = useState<DeletionPlan | null>(null);
  const [name, setName] = useState("");
  const [leaveSharedArchives, setLeaveSharedArchives] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  async function showPlan() {
    setOpen(true);
    setBusy(true);
    setError("");
    try {
      const response = await fetch("/api/account/deletion", {
        cache: "no-store",
      });
      const value = await response.json();
      if (!response.ok)
        throw new Error(value.error || "Не удалось проверить аккаунт");
      setPlan(value as DeletionPlan);
    } catch (cause) {
      setError((cause as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function remove() {
    if (!plan || name !== plan.name) return;
    setBusy(true);
    setError("");
    try {
      const response = await fetch("/api/account/deletion", {
        method: "DELETE",
        headers: {
          "Content-Type": "application/json",
          "X-Drevo-Account-Deletion": "1",
        },
        body: JSON.stringify({ name, leaveSharedArchives }),
      });
      const value = await response.json();
      if (!response.ok)
        throw new Error(value.error || "Не удалось удалить аккаунт");
      await clearLayoutStorage().catch(() => {});
      window.location.replace("/");
    } catch (cause) {
      setError((cause as Error).message);
      setBusy(false);
    }
  }

  return (
    <div className="account-archive-deletion">
      {!open ? (
        <button type="button" onClick={() => void showPlan()}>
          Удалить аккаунт
        </button>
      ) : (
        <div className="account-archive-deletion-form">
          <strong>Удаление аккаунта</strong>
          {busy && !plan && <p>Проверяем данные…</p>}
          {plan?.ownedArchives ? (
            <p role="status">
              Сначала передайте или удалите своё дерево. После этого можно
              удалить аккаунт.
            </p>
          ) : null}
          {plan && plan.ownedArchives === 0 && (
            <>
              <p>
                Способы входа, сеансы и личные ИИ-диалоги будут удалены.
                Материалы, внесённые в чужие деревья, останутся у их владельцев.
                Резервные копии хранятся до окончания установленного срока.
              </p>
              {plan.sharedArchives > 0 && (
                <label className="account-archive-deletion-consent">
                  <input
                    type="checkbox"
                    checked={leaveSharedArchives}
                    onChange={(event) =>
                      setLeaveSharedArchives(event.target.checked)
                    }
                  />
                  <span>
                    Понимаю, что потеряю доступ ещё к {plan.sharedArchives}{" "}
                    деревьям, куда меня пригласили.
                  </span>
                </label>
              )}
              <label>
                Для подтверждения введите имя аккаунта: {plan.name}
                <input
                  type="text"
                  value={name}
                  onChange={(event) => setName(event.target.value)}
                  autoComplete="off"
                />
              </label>
              <div className="account-archive-deletion-actions">
                <button
                  type="button"
                  className="account-archive-deletion-confirm"
                  disabled={
                    busy ||
                    name !== plan.name ||
                    (plan.sharedArchives > 0 && !leaveSharedArchives)
                  }
                  onClick={() => void remove()}
                >
                  {busy ? "Удаляем…" : "Удалить аккаунт"}
                </button>
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => {
                    setOpen(false);
                    setPlan(null);
                    setName("");
                    setLeaveSharedArchives(false);
                    setError("");
                  }}
                >
                  Отмена
                </button>
              </div>
            </>
          )}
          {plan?.ownedArchives ? (
            <button type="button" onClick={() => setOpen(false)}>
              Закрыть
            </button>
          ) : null}
          {error && (
            <p className="account-error" role="alert">
              {error}
            </p>
          )}
        </div>
      )}
    </div>
  );
}
