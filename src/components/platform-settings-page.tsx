import { BackupAdmin } from "./backup-admin";
import { useCallback, useEffect, useRef } from "react";
import { confirmDiscardChanges } from "../hooks/useUnsavedChanges";
import {
  ArrowLeft,
  Bot,
  DatabaseBackup,
  HardDrive,
  KeyRound,
  Mail,
  ScanSearch,
  ShieldCheck,
  Users,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { AdminNavigation } from "./admin-navigation";
import { PlatformAccountsAdmin } from "./platform-accounts-admin";
import { AiSettingsAdmin } from "./ai-settings-admin";
import { AiProviderCleanupAdmin } from "./ai-provider-cleanup-admin";
import { StorageLimitsAdmin } from "./storage-limits-admin";
import { VkAuthAdmin } from "./vk-auth-admin";
import { EmailAuthAdmin } from "./email-auth-admin";
import { ResearchResourcesAdmin } from "./research-resources-admin";
import "../styles/account.css";

type Section =
  "roles" | "ai" | "backups" | "storage" | "vk" | "email" | "resources";
const sections: { id: Section; label: string; icon: LucideIcon }[] = [
  { id: "roles", label: "Пользователи", icon: Users },
  { id: "ai", label: "Yandex AI", icon: Bot },
  { id: "backups", label: "Резервные копии", icon: DatabaseBackup },
  { id: "storage", label: "Хранилище", icon: HardDrive },
  { id: "vk", label: "Вход через VK", icon: KeyRound },
  { id: "email", label: "Вход по email", icon: Mail },
  { id: "resources", label: "Ресурсы поиска", icon: ScanSearch },
];
/** Account-scoped entry for settings shared by the entire platform. */
export default function PlatformSettingsPage({
  accountId,
  onOwnRoleChanged,
  onOwnTierChanged,
  showRoles = true,
  onDirtyChange,
  currentPath,
  onNavigate,
}: {
  accountId: string;
  currentPath: string;
  onNavigate: (path: string) => void;
  onOwnRoleChanged: (role: "admin" | "researcher" | null) => void;
  onOwnTierChanged: (fullAccess: boolean) => void;
  showRoles?: boolean;
  onDirtyChange?: (dirty: boolean) => void;
}) {
  const requested = new URLSearchParams(currentPath.split("?")[1] || "").get(
    "section",
  );
  const section =
    sections.find(
      (item) => item.id === requested && (showRoles || item.id !== "roles"),
    )?.id || (showRoles ? "roles" : "ai");
  const sectionPath = (next: Section) =>
    next === "roles" ? "/admin" : `/admin?section=${next}`;
  useEffect(() => {
    document.title = `${sections.find((item) => item.id === section)!.label} · Админка · Drevo`;
  }, [section]);
  const sectionDirty = useRef(false);
  const reportDirty = useCallback(
    (dirty: boolean) => {
      sectionDirty.current = dirty;
      onDirtyChange?.(dirty);
    },
    [onDirtyChange],
  );
  return (
    <main className="account-page admin-page platform-settings-page">
      <aside className="admin-sidebar">
        <div className="admin-mark">
          <span className="admin-mark-icon">
            <ShieldCheck size={20} aria-hidden="true" />
          </span>
          <span>
            <small>DREVO</small>
            <b>Админка платформы</b>
          </span>
        </div>
        <AdminNavigation
          groups={[
            {
              label: "Доступ",
              items: sections.filter(
                (item) => item.id === "roles" && showRoles,
              ),
            },
            {
              label: "Интеграции",
              items: sections.filter((item) =>
                ["ai", "vk", "email"].includes(item.id),
              ),
            },
            {
              label: "Данные",
              items: sections.filter((item) =>
                ["backups", "storage", "resources"].includes(item.id),
              ),
            },
          ].filter((group) => group.items.length > 0)}
          href={sectionPath}
          selected={section}
          label="Разделы админки платформы"
          onSelect={(next) => {
            if (
              next !== section &&
              !confirmDiscardChanges(sectionDirty.current)
            )
              return;
            if (next !== section) onNavigate(sectionPath(next));
          }}
        />
        <a
          className="admin-back"
          href="/account"
          aria-label="Вернуться в профиль"
          title="Вернуться в профиль"
          onClick={(event) => {
            if (
              !event.ctrlKey &&
              !event.metaKey &&
              !event.shiftKey &&
              !event.altKey &&
              !confirmDiscardChanges(sectionDirty.current)
            )
              event.preventDefault();
          }}
        >
          <ArrowLeft size={16} aria-hidden="true" />
          <span>Вернуться в профиль</span>
        </a>
      </aside>
      <div className="admin-content platform-settings-content">
        <header className="admin-page-header">
          <h1>Админка платформы</h1>
          <p className="admin-subtitle">
            Настройки всех древ. Доступ участников к конкретному древу задаётся
            в его управлении.
          </p>
        </header>
        {showRoles && section === "roles" && (
          <PlatformAccountsAdmin
            currentAccountId={accountId}
            onOwnRoleChanged={onOwnRoleChanged}
            onOwnTierChanged={onOwnTierChanged}
          />
        )}
        {section === "ai" && (
          <div className="platform-ai-settings">
            <AiSettingsAdmin showCleanup={false} onDirtyChange={reportDirty} />
            <AiProviderCleanupAdmin platform />
          </div>
        )}
        {section === "backups" && (
          <BackupAdmin
            scope="platform"
            archiveId={null}
            onDirtyChange={reportDirty}
          />
        )}
        {section === "storage" && (
          <section className="account-card">
            <div className="account-card-title">
              <div>
                <span className="account-eyebrow">Платформа</span>
                <h2>Лимиты хранилища</h2>
              </div>
            </div>
            <StorageLimitsAdmin onDirtyChange={reportDirty} />
          </section>
        )}
        {section === "vk" && (
          <section className="account-card">
            <div className="account-card-title">
              <div>
                <span className="account-eyebrow">Платформа</span>
                <h2>Вход через VK</h2>
              </div>
            </div>
            <VkAuthAdmin onDirtyChange={reportDirty} />
          </section>
        )}
        {section === "email" && (
          <section className="account-card">
            <div className="account-card-title">
              <div>
                <span className="account-eyebrow">Платформа</span>
                <h2>Вход по email</h2>
              </div>
            </div>
            <EmailAuthAdmin onDirtyChange={reportDirty} />
          </section>
        )}
        {section === "resources" && (
          <section className="account-card account-card-wide">
            <div className="account-card-title">
              <div>
                <span className="account-eyebrow">Платформа</span>
                <h2>Ресурсы поиска</h2>
              </div>
            </div>
            <ResearchResourcesAdmin onDirtyChange={reportDirty} />
          </section>
        )}
      </div>
    </main>
  );
}
