import { useEffect, useState } from "react";
import { ROLE_NAMES, type ArchiveUser, type Role } from "../domain";
import { EditorDialog } from "./editor-dialog";
export function AdminPanel({
  onClose,
  onChanged,
}: {
  onClose: () => void;
  onChanged: () => void;
}) {
  const [users, setUsers] = useState<ArchiveUser[]>([]),
    [visibility, setVisibility] = useState<{
      publicTree: boolean;
      publicAlbums: boolean;
    } | null>(null),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false),
    [notice, setNotice] = useState("");
  useEffect(() => {
    const controller = new AbortController();
    void Promise.all([
      fetch("/api/users", { signal: controller.signal }),
      fetch("/api/settings", { signal: controller.signal }),
    ])
      .then(async ([u, s]) => {
        if (!u.ok || !s.ok) throw new Error("Нет доступа к управлению архивом");
        setUsers((await u.json()).users);
        setVisibility(await s.json());
      })
      .catch((e) => {
        if (!controller.signal.aborted) setError(e.message);
      });
    return () => controller.abort();
  }, []);
  async function change(url: string, method: string, body: unknown) {
    setBusy(true);
    setError("");
    setNotice("");
    try {
      const response = await fetch(url, {
        method,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "Не удалось сохранить");
      onChanged();
      setNotice("Изменения сохранены");
      return data;
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <EditorDialog title="Управление архивом" onClose={onClose}>
      <div className="archive-form">
        <section>
          <h3>Публичный просмотр</h3>
          <p>
            Без входа доступны только включённые разделы. Редактирование всегда
            требует входа и подходящей роли.
          </p>
          {visibility && (
            <>
              <label className="check-field">
                <input
                  type="checkbox"
                  checked={visibility.publicTree}
                  onChange={(e) =>
                    setVisibility({
                      ...visibility,
                      publicTree: e.target.checked,
                    })
                  }
                />{" "}
                Древо и каталог семей доступны всем
              </label>
              <label className="check-field">
                <input
                  type="checkbox"
                  checked={visibility.publicAlbums}
                  onChange={(e) =>
                    setVisibility({
                      ...visibility,
                      publicAlbums: e.target.checked,
                    })
                  }
                />{" "}
                Фотоальбомы доступны всем
              </label>
              <button
                disabled={busy}
                onClick={() => void change("/api/settings", "PUT", visibility)}
              >
                Сохранить видимость
              </button>
            </>
          )}
        </section>
        <section>
          <h3>Участники</h3>
          <p>
            Первый вошедший через Яндекс стал администратором. Новые участники
            получают просмотр. Родственники создают и редактируют свои карточки.
          </p>
          {users.map((user) => (
            <div className="connection-row" key={user.id}>
              <span>
                <b>{user.name}</b>
                <br />
                <small>Яндекс ID: {user.id}</small>
              </span>
              <label>
                Роль
                <select
                  aria-label={`Роль: ${user.name}`}
                  value={user.role}
                  disabled={busy}
                  onChange={async (e) => {
                    const data = await change(
                      `/api/users/${encodeURIComponent(user.id)}`,
                      "PATCH",
                      { role: e.target.value as Role },
                    );
                    if (data) setUsers(data.users);
                  }}
                >
                  {Object.entries(ROLE_NAMES).map(([role, name]) => (
                    <option key={role} value={role}>
                      {name}
                    </option>
                  ))}
                </select>
              </label>
            </div>
          ))}
        </section>
        <section>
          <h3>Резервные копии</h3>
          <p>
            База содержит людей, связи, отметки, пользователей и настройки
            доступа. Полный бэкап также включает файлы фотографий.
          </p>
          <div className="backup-actions">
            <a className="primary-action" href="/api/backup" download>
              Скачать базу SQLite
            </a>
            <a className="primary-action" href="/api/backup/full" download>
              Скачать базу и фото
            </a>
          </div>
        </section>
        {error && (
          <p className="form-error" role="alert">
            {error}
          </p>
        )}
        {notice && <p role="status">{notice}</p>}
      </div>
    </EditorDialog>
  );
}
