import { useState } from "react";
import { archiveFetch } from "../data/archive-fetch.ts";

type DeletionPlan = {
  title: string;
  people: number;
  photos: number;
  documents: number;
  otherMembers: number;
};

export function AccountArchiveDeletion() {
  const [open, setOpen] = useState(false);
  const [plan, setPlan] = useState<DeletionPlan | null>(null);
  const [title, setTitle] = useState("");
  const [removeCollaborators, setRemoveCollaborators] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  async function showPlan() {
    setOpen(true);
    setBusy(true);
    setError("");
    try {
      const response = await archiveFetch("/api/account/archive-deletion");
      const value = await response.json();
      if (!response.ok)
        throw new Error(value.error || "Не удалось проверить древо");
      setPlan(value as DeletionPlan);
    } catch (cause) {
      setError((cause as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function remove() {
    if (!plan || title !== plan.title) return;
    setBusy(true);
    setError("");
    try {
      const response = await archiveFetch("/api/account/archive-deletion", {
        method: "DELETE",
        headers: {
          "Content-Type": "application/json",
          "X-Drevo-Archive-Deletion": "1",
        },
        body: JSON.stringify({ title, removeCollaborators }),
      });
      const value = await response.json();
      if (!response.ok)
        throw new Error(value.error || "Не удалось удалить древо");
      window.location.assign("/account");
    } catch (cause) {
      setError((cause as Error).message);
      setBusy(false);
    }
  }

  return (
    <div className="account-archive-deletion">
      {!open ? (
        <button type="button" onClick={() => void showPlan()}>
          Удалить это древо
        </button>
      ) : (
        <div className="account-archive-deletion-form">
          <strong>Удаление древа</strong>
          {busy && !plan && <p>Проверяем данные…</p>}
          {plan && (
            <>
              <p>
                Будут удалены «{plan.title}», {plan.people} человек,{" "}
                {plan.photos} фото и {plan.documents} документов. Сначала
                скачайте переносимый архив, если хотите сохранить эти данные.
                Серверные резервные копии хранятся до окончания установленного
                срока.
              </p>
              {plan.otherMembers > 0 && (
                <label className="account-archive-deletion-consent">
                  <input
                    type="checkbox"
                    checked={removeCollaborators}
                    onChange={(event) =>
                      setRemoveCollaborators(event.target.checked)
                    }
                  />
                  <span>
                    Понимаю, что доступ к древу потеряют ещё{" "}
                    {plan.otherMembers} участников. Вместо удаления можно
                    передать владение участнику.
                  </span>
                </label>
              )}
              <label>
                Для подтверждения введите название древа
                <input
                  type="text"
                  value={title}
                  onChange={(event) => setTitle(event.target.value)}
                  autoComplete="off"
                />
              </label>
              <div className="account-archive-deletion-actions">
                <button
                  type="button"
                  className="account-archive-deletion-confirm"
                  disabled={
                    busy ||
                    title !== plan.title ||
                    (plan.otherMembers > 0 && !removeCollaborators)
                  }
                  onClick={() => void remove()}
                >
                  {busy ? "Удаляем…" : "Удалить древо и файлы"}
                </button>
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => {
                    setOpen(false);
                    setPlan(null);
                    setTitle("");
                    setRemoveCollaborators(false);
                    setError("");
                  }}
                >
                  Отмена
                </button>
              </div>
            </>
          )}
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
