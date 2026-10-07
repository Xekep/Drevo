import { useState } from "react";
import { ROLE_NAMES, type Role } from "../domain/access";
import {
  AI_CAPABILITY_LABELS,
  type AiRoleProfile,
  type AiRoleProfiles,
} from "../shared/ai-role-profiles";

export function AiRoleProfilesEditor({
  profiles,
  defaults,
  models,
  disabled,
  onChange,
  onTest,
  codeInterpreterAllowed,
  globallyEnabled,
}: {
  profiles: AiRoleProfiles;
  defaults: AiRoleProfile;
  models: Array<{ id: string; label: string }>;
  disabled: boolean;
  onChange: (profiles: AiRoleProfiles) => void;
  onTest: (role: Role) => void;
  codeInterpreterAllowed: boolean;
  globallyEnabled: boolean;
}) {
  const [role, setRole] = useState<Role>("relative");
  const inherited = profiles[role] === null;
  const profile = profiles[role] || defaults;
  const update = (change: Partial<AiRoleProfile>) =>
    onChange({ ...profiles, [role]: { ...profile, ...change } });
  const modelOptions = (value: string, placeholder: string) => (
    <>
      <option value="">{placeholder}</option>
      {value && !models.some((model) => model.id === value) && (
        <option value={value}>{value}</option>
      )}
      {models.map((model) => (
        <option key={model.id} value={model.id}>
          {model.label}
        </option>
      ))}
    </>
  );

  return (
    <fieldset className="ai-role-profiles" disabled={disabled}>
      <legend>Доступ и лимиты по ролям</legend>
      <div
        className="ai-role-choices"
        role="group"
        aria-label="Роль пользователя"
      >
        {Object.entries(ROLE_NAMES).map(([key, label]) => {
          const selectedRole = key as Role;
          const configured = profiles[selectedRole];
          const accessible = globallyEnabled && (configured?.enabled ?? true);
          return (
            <button
              key={key}
              type="button"
              aria-pressed={role === selectedRole}
              onClick={() => setRole(selectedRole)}
            >
              <b>{label}</b>
              <small>
                {!accessible
                  ? "Нет доступа"
                  : configured
                    ? "Свои настройки"
                    : "Общие настройки"}
              </small>
            </button>
          );
        })}
      </div>
      <label
        className="setting-toggle"
        htmlFor="ai-profile-inherit"
        aria-label="Использовать общие настройки"
      >
        <span>
          <b>Использовать общие настройки</b>
        </span>
        <input
          id="ai-profile-inherit"
          type="checkbox"
          checked={inherited}
          onChange={(event) =>
            onChange({
              ...profiles,
              [role]: event.target.checked ? null : { ...defaults, model: "" },
            })
          }
        />
      </label>
      {inherited ? (
        <div
          className="ai-inherited-profile"
          aria-label={`Настройки ИИ: ${ROLE_NAMES[role]}`}
        >
          <p>
            <b>
              {models.find((model) => model.id === profile.model)?.label ||
                profile.model ||
                "Общая модель"}
            </b>
            <span>
              {role === "admin" || role === "researcher"
                ? "Роль платформы"
                : "Роль в древе"}
            </span>
          </p>
          <div className="ai-capability-summary">
            {Object.entries(AI_CAPABILITY_LABELS).map(([key, label]) => {
              const allowed =
                globallyEnabled &&
                profile[key as keyof typeof AI_CAPABILITY_LABELS] &&
                (key !== "codeInterpreterEnabled" || codeInterpreterAllowed) &&
                (key !== "globalSearchEnabled" || profile.webSearchEnabled) &&
                (key !== "proposalsEnabled" || role !== "reader");
              return (
                <span key={key} className={allowed ? "is-enabled" : ""}>
                  {allowed ? "✓" : "—"} {label}
                </span>
              );
            })}
          </div>
          <small>
            {profile.requestsPerMinute
              ? `${profile.requestsPerMinute} запросов в минуту на человека`
              : "Без минутного лимита"}
            . Личные дневные лимиты не заданы; действует общий бюджет древа.
          </small>
        </div>
      ) : (
        <fieldset
          className="ai-role-profile-custom"
          disabled={inherited}
          aria-label={`Настройки ИИ: ${ROLE_NAMES[role]}`}
        >
          <legend>{ROLE_NAMES[role]}</legend>
          <div className="ai-role-profile-main">
            <label
              className="setting-toggle"
              htmlFor="ai-profile-enabled"
              aria-label="Доступ к ИИ"
            >
              <span>
                <b>Доступ к ИИ</b>
              </span>
              <input
                id="ai-profile-enabled"
                type="checkbox"
                checked={profile.enabled}
                onChange={(event) => update({ enabled: event.target.checked })}
              />
            </label>
            <label htmlFor="ai-profile-model">
              Модель для этой роли
              <select
                id="ai-profile-model"
                aria-label="Модель для этой роли"
                value={profile.model}
                onChange={(event) => update({ model: event.target.value })}
              >
                {modelOptions(profile.model, "Общая модель")}
              </select>
            </label>
          </div>
          <div className="ai-role-capabilities">
            {Object.entries(AI_CAPABILITY_LABELS).map(([key, label]) => {
              const capability = key as keyof typeof AI_CAPABILITY_LABELS;
              return (
                <label
                  key={key}
                  className="setting-toggle"
                  htmlFor={`ai-profile-${key}`}
                >
                  <span>{label}</span>
                  <input
                    id={`ai-profile-${key}`}
                    type="checkbox"
                    title={
                      capability === "proposalsEnabled"
                        ? "Только в пределах прав пользователя, после подтверждения. Читателю недоступно."
                        : capability === "globalSearchEnabled"
                          ? "Доступен при включённом поиске по доверенным ресурсам."
                          : capability === "codeInterpreterEnabled"
                            ? "Расчёты и файлы в изолированной среде Yandex; расходуют бюджет ИИ."
                            : undefined
                    }
                    checked={
                      (capability === "proposalsEnabled" &&
                        role === "reader") ||
                      (capability === "globalSearchEnabled" &&
                        !profile.webSearchEnabled) ||
                      (capability === "codeInterpreterEnabled" &&
                        !codeInterpreterAllowed)
                        ? false
                        : profile[capability]
                    }
                    disabled={
                      (capability === "codeInterpreterEnabled" &&
                        !codeInterpreterAllowed) ||
                      (capability === "globalSearchEnabled" &&
                        !profile.webSearchEnabled) ||
                      (capability === "proposalsEnabled" && role === "reader")
                    }
                    onChange={(event) =>
                      update({ [capability]: event.target.checked })
                    }
                  />
                  {capability === "codeInterpreterEnabled" &&
                    !codeInterpreterAllowed && (
                      <small>Общий доступ выключен</small>
                    )}
                </label>
              );
            })}
          </div>
          <div className="ai-limit-settings ai-role-limits">
            {(
              [
                [
                  "requestsPerMinute",
                  "Запросов в минуту на пользователя",
                  "Запросов / мин",
                  120,
                ],
                [
                  "dailyRequests",
                  "Запросов в день на пользователя",
                  "Запросов / день",
                  100000,
                ],
                [
                  "dailyTokens",
                  "Токенов в день на пользователя",
                  "Токенов / день",
                  1000000000,
                ],
              ] as const
            ).map(([key, label, caption, max]) => (
              <label key={key} htmlFor={`ai-profile-${key}`}>
                {caption}
                <input
                  id={`ai-profile-${key}`}
                  aria-label={label}
                  type="number"
                  min={0}
                  max={max}
                  value={profile[key]}
                  onChange={(event) =>
                    update({ [key]: Number(event.target.value) })
                  }
                />
              </label>
            ))}
          </div>
          <small>
            0 — без личного лимита. Общий бюджет и права на данные продолжают
            действовать.
          </small>
          <details className="ai-context-settings ai-role-advanced">
            <summary>Модель фото и контекст</summary>
            <label htmlFor="ai-profile-vision-model">
              Модель анализа фотографий
              <select
                id="ai-profile-vision-model"
                value={profile.visionModel}
                disabled={!profile.photoAnalysisEnabled}
                onChange={(event) =>
                  update({ visionModel: event.target.value })
                }
              >
                {modelOptions(profile.visionModel, "Автоматический выбор")}
              </select>
              <small>
                При ручном выборе нужна модель с поддержкой изображений. Список
                Yandex не сообщает все возможности моделей.
              </small>
            </label>
            <details className="ai-context-settings">
              <summary>Контекст и шаги инструментов</summary>
              <label
                className="setting-toggle"
                htmlFor="ai-profile-compaction"
                aria-label="Сжимать длинный диалог для этой роли"
              >
                <span>
                  <b>Сжимать длинный диалог</b>
                </span>
                <input
                  id="ai-profile-compaction"
                  type="checkbox"
                  checked={profile.compactionEnabled}
                  onChange={(event) =>
                    update({ compactionEnabled: event.target.checked })
                  }
                />
              </label>
              <label htmlFor="ai-profile-threshold">
                Порог сжатия, токенов
                <input
                  id="ai-profile-threshold"
                  type="number"
                  min={1000}
                  max={1000000}
                  value={profile.compactThresholdTokens}
                  disabled={!profile.compactionEnabled}
                  onChange={(event) =>
                    update({
                      compactThresholdTokens: Number(event.target.value),
                    })
                  }
                />
              </label>
              <label
                className="setting-toggle"
                htmlFor="ai-profile-truncation"
                aria-label="Автоматически сокращать контекст для этой роли"
              >
                <span>
                  <b>Автоматически сокращать контекст</b>
                </span>
                <input
                  id="ai-profile-truncation"
                  type="checkbox"
                  checked={profile.automaticTruncation}
                  onChange={(event) =>
                    update({ automaticTruncation: event.target.checked })
                  }
                />
              </label>
              <label htmlFor="ai-profile-iterations">
                Максимум шагов инструментов
                <input
                  id="ai-profile-iterations"
                  type="number"
                  min={1}
                  max={20}
                  value={profile.maxToolIterations}
                  onChange={(event) =>
                    update({ maxToolIterations: Number(event.target.value) })
                  }
                />
              </label>
            </details>
          </details>
        </fieldset>
      )}
      {!inherited && (
        <button type="button" onClick={() => onTest(role)}>
          Проверить модель роли
        </button>
      )}
    </fieldset>
  );
}
