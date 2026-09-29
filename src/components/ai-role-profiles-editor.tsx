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
}: {
  profiles: AiRoleProfiles;
  defaults: AiRoleProfile;
  models: Array<{ id: string; label: string }>;
  disabled: boolean;
  onChange: (profiles: AiRoleProfiles) => void;
  onTest: (role: Role) => void;
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
      <legend>AI по ролям</legend>
      <p>
        У каждой роли могут быть своя модель, возможности и лимиты. Права на
        людей и ветви древа сохраняются.
      </p>
      <label htmlFor="ai-profile-role">
        Роль пользователя
        <select
          id="ai-profile-role"
          aria-label="Роль пользователя"
          value={role}
          onChange={(event) => setRole(event.target.value as Role)}
        >
          {Object.entries(ROLE_NAMES).map(([key, label]) => (
            <option key={key} value={key}>
              {label}
            </option>
          ))}
        </select>
      </label>
      <label
        className="setting-toggle"
        htmlFor="ai-profile-inherit"
        aria-label="Использовать общие настройки"
      >
        <span>
          <b>Использовать общие настройки</b>
          <small>
            Изменения общих настроек автоматически применяются к этой роли.
          </small>
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
      <fieldset disabled={inherited}>
        <legend>{ROLE_NAMES[role]}</legend>
        <label
          className="setting-toggle"
          htmlFor="ai-profile-enabled"
          aria-label="Доступ к ИИ"
        >
          <span>
            <b>Доступ к ИИ</b>
            <small>Общий выключатель ИИ действует на все роли.</small>
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
            value={inherited ? "" : profile.model}
            onChange={(event) => update({ model: event.target.value })}
          >
            {modelOptions(profile.model, "Общая модель")}
          </select>
        </label>
        {Object.entries(AI_CAPABILITY_LABELS).map(([key, label]) => {
          const capability = key as keyof typeof AI_CAPABILITY_LABELS;
          return (
            <label
              key={key}
              className="setting-toggle"
              htmlFor={`ai-profile-${key}`}
            >
              <span>
                <b>{label}</b>
                {capability === "proposalsEnabled" && (
                  <small>
                    Только в пределах прав пользователя; каждое изменение
                    требует подтверждения. Читателю недоступно.
                  </small>
                )}
              </span>
              <input
                id={`ai-profile-${key}`}
                type="checkbox"
                checked={
                  capability === "proposalsEnabled" && role === "reader"
                    ? false
                    : profile[capability]
                }
                disabled={
                  (capability === "globalSearchEnabled" &&
                    !profile.webSearchEnabled) ||
                  (capability === "proposalsEnabled" && role === "reader")
                }
                onChange={(event) =>
                  update({ [capability]: event.target.checked })
                }
              />
            </label>
          );
        })}
        <label htmlFor="ai-profile-vision-model">
          Модель анализа фотографий
          <select
            id="ai-profile-vision-model"
            value={profile.visionModel}
            disabled={!profile.photoAnalysisEnabled}
            onChange={(event) => update({ visionModel: event.target.value })}
          >
            {modelOptions(profile.visionModel, "Автоматический выбор")}
          </select>
          <small>
            При ручном выборе нужна модель с поддержкой изображений. Список
            Yandex не сообщает все возможности моделей.
          </small>
        </label>
        <div className="ai-limit-settings">
          {(
            [
              ["requestsPerMinute", "Запросов в минуту на пользователя", 120],
              ["dailyRequests", "Запросов в день на пользователя", 100000],
              ["dailyTokens", "Токенов в день на пользователя", 1000000000],
            ] as const
          ).map(([key, label, max]) => (
            <label key={key} htmlFor={`ai-profile-${key}`}>
              {label}
              <input
                id={`ai-profile-${key}`}
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
          Ноль отключает личный лимит. Общие дневные лимиты архива действуют для
          всех ролей.
        </small>
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
                update({ compactThresholdTokens: Number(event.target.value) })
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
      </fieldset>
      <button type="button" onClick={() => onTest(role)}>
        Проверить сохранённую модель роли
      </button>
      <small>
        Проверка отправляет короткий запрос в Yandex. Сначала сохраните
        изменения. Возможности зависят от поддержки выбранной модели.
      </small>
    </fieldset>
  );
}
