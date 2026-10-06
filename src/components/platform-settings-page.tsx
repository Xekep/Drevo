import { BackupAdmin } from "./backup-admin";
import { useEffect, useState } from "react";
import { ArrowLeft, Bot, DatabaseBackup, HardDrive, KeyRound, Mail, ScanSearch, ShieldCheck, Users } from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { AdminNavigation } from "./admin-navigation";
import { archiveFetch } from "../data/archive-fetch.ts";
import { PlatformStaffRoles } from "./platform-staff-roles";
import { PlatformAccountTiers } from "./platform-account-tiers";
import { AiSettingsAdmin } from "./ai-settings-admin";
import { AiProviderCleanupAdmin } from "./ai-provider-cleanup-admin";
import { StorageLimitsAdmin } from "./storage-limits-admin";
import { VkAuthAdmin } from "./vk-auth-admin";
import { EmailAuthAdmin } from "./email-auth-admin";
import { ResearchResourcesAdmin } from "./research-resources-admin";
import "../styles/account.css";

type Section = "roles" | "ai" | "backups" | "storage" | "vk" | "email" | "resources";
const sections: { id: Section; label: string; icon: LucideIcon }[] = [
  { id: "roles", label: "Глобальные роли", icon: Users },
  { id: "ai", label: "Yandex AI", icon: Bot },
  { id: "backups", label: "Резервные копии", icon: DatabaseBackup },
  { id: "storage", label: "Хранилище", icon: HardDrive },
  { id: "vk", label: "Вход через VK", icon: KeyRound },
  { id: "email", label: "Вход по email", icon: Mail },
  { id: "resources", label: "Ресурсы поиска", icon: ScanSearch },
];
type AvailableArchive = { id: string; title: string; approved: boolean; current: boolean };

/** Account-scoped entry. Archive-specific AI settings are selected explicitly. */
export default function PlatformSettingsPage({ accountId, onOwnRoleChanged, onOwnTierChanged,
  showRoles = true }: {
  accountId: string;
  onOwnRoleChanged: (role: "admin" | "researcher" | null) => void;
  onOwnTierChanged: (fullAccess: boolean) => void;
  showRoles?: boolean;
}) {
  const [section, setSection] = useState<Section>(showRoles ? "roles" : "ai");
  const [archives, setArchives] = useState<AvailableArchive[]>([]);
  const [archivesReady, setArchivesReady] = useState(false);
  const [aiArchiveId, setAiArchiveId] = useState("");
  useEffect(() => {
    if (section !== "ai") return;
    const controller = new AbortController();
    void archiveFetch("/api/account/archives", { cache: "no-store", signal: controller.signal })
      .then(async (response) => response.ok ? response.json() : null)
      .then((body: { archives?: AvailableArchive[] } | null) => {
        if (controller.signal.aborted) return;
        const available = body?.archives?.filter((archive) => archive.approved && !archive.current) || [];
        setArchives(available);
        setAiArchiveId((current) => available.some((archive) => archive.id === current) ? current : "");
        setArchivesReady(true);
      })
      .catch(() => {
        if (controller.signal.aborted) return;
        setArchives([]);
        setAiArchiveId("");
        setArchivesReady(true);
      });
    return () => controller.abort();
  }, [section]);

  return (
    <main className="account-page admin-page platform-settings-page">
      <aside className="admin-sidebar">
        <div className="admin-mark">
          <span className="admin-mark-icon"><ShieldCheck size={20} aria-hidden="true" /></span>
          <span><small>DREVO</small><b>Админка платформы</b></span>
        </div>
        <AdminNavigation groups={[{ label: "Настройки", items: sections.filter((item) => showRoles || item.id !== "roles") }]}
          selected={section} label="Разделы админки платформы" onSelect={(next) => {
            if (next === "ai" && section !== "ai") setArchivesReady(false);
            setSection(next);
          }} />
        <a className="admin-back" href="/account" aria-label="Вернуться в профиль" title="Вернуться в профиль">
          <ArrowLeft size={16} aria-hidden="true" /><span>Вернуться в профиль</span>
        </a>
      </aside>
      <div className="admin-content platform-settings-content">
        <header className="admin-page-header">
          <h1>Админка платформы</h1>
          <p className="admin-subtitle">Глобальные роли и настройки платформы. Управление конкретным древом открывается из его меню.</p>
        </header>
        {showRoles && section === "roles" && <>
          <PlatformStaffRoles currentAccountId={accountId}
            onOwnRoleChanged={onOwnRoleChanged} />
          <PlatformAccountTiers currentAccountId={accountId} onOwnTierChanged={onOwnTierChanged} />
        </>}
        {section === "ai" && <div className="platform-ai-settings">
          <AiProviderCleanupAdmin platform />
          {!archivesReady ? <p role="status">Проверяем доступные архивы…</p> : <>
          <label className="platform-ai-archive">
            Архив для Yandex AI
            <select value={aiArchiveId} onChange={(event) => setAiArchiveId(event.target.value)}>
              <option value="">Основной архив</option>
              {archives.map((archive) => <option key={archive.id} value={archive.id}>{archive.title}</option>)}
            </select>
            <small>Настройки ИИ задаются отдельно для выбранного архива.</small>
          </label>
          <AiSettingsAdmin key={aiArchiveId} archiveId={aiArchiveId || null}
            showCleanup={false} />
          </>}
        </div>}
        {section === "backups" && <BackupAdmin scope="platform" archiveId={null} />}
        {section === "storage" && <section className="account-card">
          <div className="account-card-title"><div><span className="account-eyebrow">Платформа</span>
            <h2>Лимиты хранилища</h2></div></div>
          <StorageLimitsAdmin />
        </section>}
        {section === "vk" && <section className="account-card">
          <div className="account-card-title"><div><span className="account-eyebrow">Платформа</span>
            <h2>Вход через VK</h2></div></div>
          <VkAuthAdmin />
        </section>}
        {section === "email" && <section className="account-card">
          <div className="account-card-title"><div><span className="account-eyebrow">Платформа</span>
            <h2>Вход по email</h2></div></div>
          <EmailAuthAdmin />
        </section>}
        {section === "resources" && <section className="account-card account-card-wide">
          <div className="account-card-title"><div><span className="account-eyebrow">Платформа</span>
            <h2>Ресурсы поиска</h2></div></div>
          <ResearchResourcesAdmin />
        </section>}
      </div>
    </main>
  );
}
