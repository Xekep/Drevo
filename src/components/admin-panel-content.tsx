import { useEffect, useState } from "react";
import {
  ArrowLeft,
  ArrowDownUp,
  DatabaseBackup,
  Download,
  Image,
  ShieldCheck,
  Users,
  History,
  Link2,
} from "lucide-react";
import {
  ROLE_NAMES,
  type ArchiveUser,
  type Role,
  type Family,
} from "../domain";
import { BackupRestore } from "./backup-restore";
import { ShareCatalog } from "./share-catalog";
import { AuditLog } from "./audit-log";
import { GedcomTransfer } from "./gedcom-transfer";
type Settings = {
  publicTree: boolean;
  publicAlbums: boolean;
  reverseTimeline: boolean;
};
export function AdminPanel({
  family,
  onClose,
  onChanged,
  onSettings,
}: {
  family: Family;
  onClose: () => void;
  onChanged: () => void;
  onSettings: () => void;
}) {
  const [section, setSection] = useState("users"),
    [users, setUsers] = useState<ArchiveUser[]>([]),
    [settings, setSettings] = useState<Settings | null>(null),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false),
    [notice, setNotice] = useState("");
  const [auditActor, setAuditActor] = useState("");
  useEffect(() => {
    const controller = new AbortController();
    void Promise.all([
      fetch("/api/users", { signal: controller.signal }),
      fetch("/api/settings", { signal: controller.signal }),
    ])
      .then(async ([u, s]) => {
        if (!u.ok || !s.ok) throw new Error("Нет доступа к управлению архивом");
        setUsers((await u.json()).users);
        setSettings(await s.json());
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
    <main className="admin-page">
      <aside className="admin-sidebar">
        <div className="admin-mark">
          <ShieldCheck size={28} />
          <span>
            УПРАВЛЕНИЕ
            <br />
            <b>Семейный архив</b>
          </span>
        </div>
        <nav aria-label="Разделы админки">
          {[
            ["users", "Участники", Users],
            ["access", "Доступ и древо", ArrowDownUp],
            ["data", "Данные и копии", DatabaseBackup],
            ["shares", "Временные ссылки", Link2],
            ["audit", "Журнал правок", History],
          ].map(([id, label, Icon]) => {
            const ItemIcon = Icon as typeof Users;
            return (
              <button
                key={String(id)}
                aria-current={section === id ? "page" : undefined}
                onClick={() => {
                  setSection(String(id));
                  setNotice("");
                }}
              >
                <ItemIcon size={18} />
                {String(label)}
              </button>
            );
          })}
        </nav>
        <button className="admin-back" onClick={onClose}>
          <ArrowLeft size={16} />
          Вернуться к древу
        </button>
      </aside>
      <div className="admin-content">
        <span className="section-label">АДМИНИСТРАТОР</span>
        <h1>Управление архивом</h1>
        <p className="admin-subtitle">
          Доступ для семьи, вид древа и сохранность вашей истории.
        </p>
        <div className="admin-stats">
          <div>
            <Users size={20} />
            <b>{family.people.length}</b>
            <span>Людей в древе</span>
          </div>
          <div>
            <Image size={20} />
            <b>{family.photos?.length || 0}</b>
            <span>Фотографий</span>
          </div>
          <div>
            <ShieldCheck size={20} />
            <b>{users.length}</b>
            <span>Участников</span>
          </div>
        </div>
        {!settings && !error && <p role="status">Загружаем настройки…</p>}
        {settings && section === "users" && (
          <section className="admin-card archive-form">
            <h2>Участники и роли</h2>
            <p>
              Новые участники могут читать архив. Родственник добавляет и
              редактирует свои карточки и снимки. Администратор управляет всем
              архивом.
            </p>
            {!users.length && (
              <p>
                После первого входа через Яндекс здесь появятся участники. На
                этом компьютере управление доступно без входа.
              </p>
            )}
            {users.map((user) => (
              <div className="admin-user" key={user.id}>
                <span className="member-avatar">{user.name.slice(0, 1)}</span>
                <div>
                  <b>{user.name}</b>
                  <small>{ROLE_NAMES[user.role]}</small>
                </div>
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
                    {Object.entries(ROLE_NAMES).map(([role, label]) => (
                      <option key={role} value={role}>
                        {label}
                      </option>
                    ))}
                  </select>
                </label>
              </div>
            ))}
          </section>
        )}
        {settings && section === "access" && (
          <form
            className="admin-card archive-form"
            onSubmit={async (e) => {
              e.preventDefault();
              const saved = await change("/api/settings", "PUT", settings);
              if (saved) setSettings(saved);
            }}
          >
            <h2>Публичный просмотр</h2>
            <p>Выберите, что смогут видеть гости без входа в аккаунт.</p>
            <label
              className="setting-toggle"
              htmlFor="public-tree"
              aria-label="Публичное древо и семьи"
            >
              <span>
                <b>Древо и семьи</b>
                <small>Люди, карточки и родственные связи</small>
              </span>
              <input
                type="checkbox"
                id="public-tree"
                checked={settings.publicTree}
                onChange={(e) =>
                  setSettings({ ...settings, publicTree: e.target.checked })
                }
              />
            </label>
            <label
              className="setting-toggle"
              htmlFor="public-albums"
              aria-label="Публичные фотоальбомы"
            >
              <span>
                <b>Фотоальбомы</b>
                <small>Фотографии и описания снимков</small>
              </span>
              <input
                type="checkbox"
                id="public-albums"
                checked={settings.publicAlbums}
                onChange={(e) =>
                  setSettings({ ...settings, publicAlbums: e.target.checked })
                }
              />
            </label>
            <h2>Направление времени</h2>
            <p>
              Настройка действует для всех: эпохи, века, люди и связи меняют
              направление вместе.
            </p>
            <div className="timeline-options">
              <label className={!settings.reverseTimeline ? "selected" : ""}>
                <input
                  type="radio"
                  name="timeline"
                  checked={!settings.reverseTimeline}
                  onChange={() =>
                    setSettings({ ...settings, reverseTimeline: false })
                  }
                />
                <b>Предки сверху</b>
                <span>Империя → СССР → Россия</span>
                <small>От прошлого к настоящему, сверху вниз</small>
              </label>
              <label className={settings.reverseTimeline ? "selected" : ""}>
                <input
                  type="radio"
                  name="timeline"
                  checked={settings.reverseTimeline}
                  onChange={() =>
                    setSettings({ ...settings, reverseTimeline: true })
                  }
                />
                <b>Младшие сверху</b>
                <span>Россия → СССР → Империя</span>
                <small>От настоящего к прошлому, сверху вниз</small>
              </label>
            </div>
            <footer>
              <button className="primary-action" disabled={busy}>
                {busy ? "Сохраняем…" : "Сохранить настройки"}
              </button>
            </footer>
          </form>
        )}
        {section === "shares" && <ShareCatalog />}
        {section === "audit" && (
          <section className="admin-card archive-form">
            <h2>Журнал правок</h2>
            <label>
              Кто изменил
              <select
                value={auditActor}
                onChange={(e) => setAuditActor(e.target.value)}
              >
                <option value="">Все участники</option>
                {users.map((u) => (
                  <option key={u.id} value={u.id}>
                    {u.name}
                  </option>
                ))}
                <option value="system">Система</option>
              </select>
            </label>
            <AuditLog key={auditActor} actorId={auditActor || undefined} />
          </section>
        )}
        {section === "data" && (
          <section className="admin-card archive-form">
            <h2>Резервные копии</h2>
            <p>
              Скачайте весь архив с фотографиями или только базу. В базу входят
              карточки, связи, отметки, участники и настройки.
            </p>
            <div className="backup-actions">
              <a className="primary-action" href="/api/backup/full" download>
                <DatabaseBackup size={18} />
                Скачать базу и фото
              </a>
              <a href="/api/backup" download>
                Только база SQLite
              </a>
            </div>
            <hr />
            <BackupRestore onRestored={onChanged} />
            <hr />
            <GedcomTransfer onImported={onChanged} />
            <hr />
            <h2>Настройки и перенос данных</h2>
            <a href="/api/export.json?download=1" download="drevo-family.json">
              <Download size={18} /> Экспорт JSON без фото
            </a>
            <p>
              Карточки и связи для анализа. Для восстановления используйте
              резервную копию.
            </p>
            <p>Название архива, описание и импорт сохранённого JSON.</p>
            <button onClick={onSettings}>Открыть настройки данных</button>
          </section>
        )}
        {error && (
          <p role="alert" className="form-error">
            {error}
          </p>
        )}
        {notice && (
          <p className="admin-notice" role="status">
            {notice}
          </p>
        )}
      </div>
    </main>
  );
}