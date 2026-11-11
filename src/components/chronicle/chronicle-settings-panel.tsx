import { useCallback, useEffect, useRef, useState } from "react";
import {
  chronicleEffects,
  chronicleFields,
  chroniclePresets,
  defaultChronicleSettings,
  type ChronicleConfiguration,
  type ChronicleEffect,
  type ChronicleNumericKey,
  type ChronicleSettings,
} from "../../shared/chronicle-settings.ts";
import {
  ChronicleConfigurationError,
  readChronicleConfiguration,
  saveChronicleConfiguration,
} from "./chronicle-configuration";

const presetLabels: Record<string, string> = {
  Default: "По умолчанию",
  Custom: "Свои параметры",
  Subtle: "Мягкий",
  Crystal: "Кристалл",
  Liquid: "Текучий",
  Light: "Лёгкий",
  Heavy: "Сильный",
  Arctic: "Арктический",
  Gentle: "Спокойный",
  Strong: "Мощный",
  Tsunami: "Цунами",
  Calm: "Спокойный",
  Storm: "Буря",
  Nuclear: "Ядерный",
  Intense: "Интенсивный",
  Dreamlike: "Сновидение",
};
const globalKeys: ChronicleNumericKey[] = [
  "globalIntensity",
  "speedMultiplier",
  "distortionStrength",
  "colorEnhancement",
  "transitionDuration",
  "autoSlideSpeed",
];

/** Owns administrator hotkeys, a discardable preview and versioned global saves. */
export function useChronicleSettings(
  initial: ChronicleConfiguration,
  pause: () => void,
  preview: () => void,
) {
  const [configuration, setConfiguration] = useState(initial);
  const [draft, setDraft] = useState<ChronicleSettings>({
    ...initial.settings,
  });
  const [open, setOpen] = useState(false),
    [saving, setSaving] = useState(false);
  const [error, setError] = useState(""),
    [saved, setSaved] = useState(false);
  const opener = useRef<HTMLElement | null>(null),
    host = useRef<HTMLElement>(null);
  const write = useRef<AbortController | null>(null);
  const close = useCallback(() => {
    setOpen(false);
    opener.current?.focus({ preventScroll: true });
  }, []);
  useEffect(() => () => write.current?.abort(), []);
  useEffect(() => {
    if (open) host.current?.focus({ preventScroll: true });
  }, [open]);
  useEffect(() => {
    if (!configuration.canConfigure) return;
    let pending: AbortController | null = null;
    const key = (event: KeyboardEvent) => {
      if (event.key === "Escape" && open) {
        event.preventDefault();
        event.stopPropagation();
        if (!saving) close();
        return;
      }
      if (
        event.repeat ||
        event.ctrlKey ||
        event.metaKey ||
        event.altKey ||
        (event.code !== "KeyH" && event.key.toLowerCase() !== "h") ||
        (event.target as Element).closest(
          "input, textarea, select, [contenteditable='true']",
        )
      )
        return;
      event.preventDefault();
      event.stopPropagation();
      if (saving) return;
      if (open) {
        close();
        return;
      }
      pause();
      opener.current =
        document.activeElement instanceof HTMLElement
          ? document.activeElement
          : null;
      pending?.abort();
      pending = new AbortController();
      const request = pending;
      void readChronicleConfiguration(request.signal)
        .then((value) => {
          if (request.signal.aborted) return;
          setConfiguration(value);
          setDraft({ ...value.settings });
          setError("");
          setSaved(false);
          if (value.canConfigure) setOpen(true);
        })
        .catch((reason) => {
          if (!request.signal.aborted)
            setError(
              reason instanceof Error
                ? reason.message
                : "Не удалось проверить права",
            );
        });
    };
    document.addEventListener("keydown", key, true);
    return () => {
      pending?.abort();
      document.removeEventListener("keydown", key, true);
    };
  }, [configuration.canConfigure, open, saving, pause, close]);

  const change = (value: ChronicleSettings) => {
    setDraft(value);
    setSaved(false);
    setError("");
  };
  const applyPreset = (effect: ChronicleEffect, name: string) =>
    change({
      ...draft,
      ...chroniclePresets[effect][name],
      currentEffect: effect,
      currentEffectPreset: name,
    });
  async function save() {
    const request = new AbortController();
    write.current?.abort();
    write.current = request;
    setSaving(true);
    setError("");
    try {
      const value = await saveChronicleConfiguration(
        draft,
        configuration.version,
        request.signal,
      );
      if (!request.signal.aborted) {
        setConfiguration(value);
        setDraft({ ...value.settings });
        setSaved(true);
      }
    } catch (reason) {
      if (!request.signal.aborted) {
        if (
          reason instanceof ChronicleConfigurationError &&
          [401, 403].includes(reason.status)
        ) {
          setConfiguration((value) => ({ ...value, canConfigure: false }));
          close();
        } else
          setError(
            reason instanceof Error
              ? reason.message
              : "Не удалось сохранить настройки",
          );
      }
    } finally {
      if (!request.signal.aborted) setSaving(false);
    }
  }
  async function reload() {
    const request = new AbortController();
    write.current?.abort();
    write.current = request;
    setSaving(true);
    try {
      const value = await readChronicleConfiguration(request.signal);
      if (!request.signal.aborted) {
        setConfiguration(value);
        setDraft({ ...value.settings });
        setError("");
        if (!value.canConfigure) close();
      }
    } catch (reason) {
      if (!request.signal.aborted)
        setError(
          reason instanceof Error
            ? reason.message
            : "Не удалось загрузить настройки",
        );
    } finally {
      if (!request.signal.aborted) setSaving(false);
    }
  }
  const effectKeys = (
    Object.keys(chronicleFields) as ChronicleNumericKey[]
  ).filter((key) => key.startsWith(draft.currentEffect));
  const field = (key: ChronicleNumericKey) => {
    const spec = chronicleFields[key];
    return (
      <label key={key}>
        {spec.label}
        <span>
          <input
            type="range"
            aria-label={spec.label}
            min={spec.min}
            max={spec.max}
            step={spec.step}
            value={draft[key]}
            onChange={(event) =>
              change({
                ...draft,
                [key]: Number(event.target.value),
                currentEffectPreset: "Custom",
              })
            }
          />
          <output>{draft[key]}</output>
        </span>
      </label>
    );
  };
  return {
    settings: open ? draft : configuration.settings,
    open,
    panel:
      open && configuration.canConfigure ? (
        <aside
          className="chronicle-settings-panel"
          ref={host}
          tabIndex={-1}
          aria-label="Настройки хроники"
        >
          <header>
            <strong>Настройки хроники</strong>
            <button type="button" disabled={saving} onClick={close}>
              Закрыть настройки
            </button>
          </header>
          <p>Общие для всех пользователей и древ. H — открыть или закрыть.</p>
          <fieldset disabled={saving}>
            <label>
              Переход
              <select
                aria-label="Переход"
                value={draft.currentEffect}
                onChange={(event) =>
                  applyPreset(event.target.value as ChronicleEffect, "Default")
                }
              >
                {Object.entries(chronicleEffects).map(([value, label]) => (
                  <option key={value} value={value}>
                    {label}
                  </option>
                ))}
              </select>
            </label>
            <label>
              Пресет
              <select
                aria-label="Пресет"
                value={draft.currentEffectPreset}
                onChange={(event) =>
                  applyPreset(draft.currentEffect, event.target.value)
                }
              >
                {[
                  ...Object.keys(chroniclePresets[draft.currentEffect]),
                  "Custom",
                ].map((name) => (
                  <option key={name} value={name}>
                    {presetLabels[name] || name}
                  </option>
                ))}
              </select>
            </label>
            <details open>
              <summary>Общие параметры</summary>
              {globalKeys.map(field)}
            </details>
            <details open>
              <summary>{chronicleEffects[draft.currentEffect]}</summary>
              {effectKeys.map(field)}
            </details>
            <div className="chronicle-settings-actions">
              <button
                type="button"
                onClick={() => {
                  const effects = Object.keys(
                    chronicleEffects,
                  ) as ChronicleEffect[];
                  const effect =
                    effects[Math.floor(Math.random() * effects.length)];
                  const next = {
                    ...draft,
                    currentEffect: effect,
                    currentEffectPreset: "Custom",
                  };
                  for (const key of Object.keys(
                    chronicleFields,
                  ) as ChronicleNumericKey[]) {
                    if (!key.startsWith(effect)) continue;
                    const spec = chronicleFields[key];
                    next[key] = Math.min(
                      spec.max,
                      Number(
                        (
                          spec.min +
                          Math.floor(
                            Math.random() *
                              ((spec.max - spec.min) / spec.step + 1),
                          ) *
                            spec.step
                        ).toFixed(3),
                      ),
                    );
                  }
                  change(next);
                }}
              >
                Случайный переход
              </button>
              <button type="button" onClick={preview}>
                Проверить переход
              </button>
              <button
                type="button"
                onClick={() => change({ ...defaultChronicleSettings })}
              >
                Сбросить
              </button>
              <button type="button" onClick={() => void save()}>
                Сохранить для всех
              </button>
            </div>
          </fieldset>
          {saved && <p role="status">Сохранено для всех древ</p>}
          {error && (
            <p role="alert">
              {error}{" "}
              <button
                type="button"
                disabled={saving}
                onClick={() => void reload()}
              >
                Загрузить актуальные
              </button>
            </p>
          )}
        </aside>
      ) : error && configuration.canConfigure ? (
        <p className="chronicle-settings-error" role="alert">
          {error}
        </p>
      ) : null,
  };
}
