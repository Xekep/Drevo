import { useEffect, useState } from "react";
import { archiveFetch } from "../data/archive-fetch.ts";
import { PlatformStaffRoles } from "./platform-staff-roles";
import { PlatformAccountTiers } from "./platform-account-tiers";
import { AiSettingsAdmin } from "./ai-settings-admin";
import { AiProviderCleanupAdmin } from "./ai-provider-cleanup-admin";
import { StorageLimitsAdmin } from "./storage-limits-admin";
import { VkAuthAdmin } from "./vk-auth-admin";
import { ResearchResourcesAdmin } from "./research-resources-admin";
import { PlatformArchiveTools } from "./platform-archive-tools";
import type { ArchiveUser } from "../domain/access.ts";
import "../styles/account.css";

type Section = "roles" | "ai" | "mcp" | "backups" | "storage" | "vk" | "resources";
const sections: { id: Section; label: string }[] = [
  { id: "roles", label: "Глобальные роли" },
  { id: "ai", label: "Yandex AI" },
  { id: "mcp", label: "MCP-токены" },
  { id: "backups", label: "Резервные копии" },
  { id: "storage", label: "Хранилище" },
  { id: "vk", label: "Вход через VK" },
  { id: "resources", label: "Ресурсы поиска" },
];
type AvailableArchive = { id: string; title: string; approved: boolean; current: boolean };

/** Account-scoped entry. Archive-specific AI settings are selected explicitly. */
export default function PlatformSettingsPage({ accountId, onOwnRoleChanged, onOwnTierChanged,
  primaryUser, local = false, showRoles = true }: {
  accountId: string;
  onOwnRoleChanged: (role: "admin" | "researcher" | null) => void;
  onOwnTierChanged: (fullAccess: boolean) => void;
  primaryUser?: ArchiveUser | null;
  local?: boolean;
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
    <main className="account-page platform-settings-page">
      <div className="account-shell">
        <div className="account-heading">
          <span className="account-eyebrow">Drevo</span>
          <h1>Админка платформы</h1>
          <p>Глобальные роли и настройки платформы. Управление конкретным древом открывается из его меню.</p>
        </div>
        <nav className="platform-settings-tabs" aria-label="Разделы админки платформы">
          {sections.filter((item) => showRoles || item.id !== "roles").map((item) => (
            <button key={item.id} type="button" aria-current={section === item.id ? "page" : undefined}
              onClick={() => {
                if (item.id === "ai" && section !== "ai") setArchivesReady(false);
                setSection(item.id);
              }}>{item.label}</button>
          ))}
        </nav>
        {showRoles && section === "roles" && <>
          <PlatformStaffRoles currentAccountId={accountId}
            onOwnRoleChanged={onOwnRoleChanged} />
          <PlatformAccountTiers currentAccountId={accountId} onOwnTierChanged={onOwnTierChanged} />
        </>}
        {section === "ai" && <div className="platform-ai-settings">
          <AiProviderCleanupAdmin platform />
          {!archivesReady ? <p role="status">Проверяем доступные архивы…</p> : <>
          <label className="account-card platform-ai-archive">
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
        {(section === "mcp" || section === "backups") && (
          <PlatformArchiveTools key={section} kind={section} accountId={accountId}
            primaryUser={primaryUser} local={local} />
        )}
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
        {section === "resources" && <section className="account-card account-card-wide">
          <div className="account-card-title"><div><span className="account-eyebrow">Платформа</span>
            <h2>Ресурсы поиска</h2></div></div>
          <ResearchResourcesAdmin />
        </section>}
      </div>
    </main>
  );
}
