import { useState } from "react";
import { ArrowUpRight, Check, Medal, Plus, Trash2, X } from "lucide-react";
import type { PersonAward } from "../domain/types";
import { safeUrl } from "../domain";
import {
  AWARD_CATALOG,
  getAwardDefinition,
  resolveAwardName,
} from "../features/awards/catalog/index.ts";
import type { AwardDefinition } from "../features/awards/types.ts";

function AwardVisual({
  definition,
  degreeId,
  size = 54,
}: {
  definition?: AwardDefinition;
  degreeId?: string;
  size?: number;
}) {
  const degree = definition?.degrees?.find((item) => item.id === degreeId);
  const image = degree?.image || definition?.image;
  const [failedSrc, setFailedSrc] = useState<string>();

  if (image && failedSrc !== image.src) {
    return (
      <img
        src={image.src}
        alt=""
        width={size}
        height={size}
        loading="lazy"
        decoding="async"
        onError={() => setFailedSrc(image.src)}
        style={{ width: size, height: size, objectFit: "contain", background: "transparent" }}
      />
    );
  }

  return <Medal size={Math.max(24, Math.round(size * 0.62))} strokeWidth={1.4} />;
}

function resolveStoredAward(award: PersonAward) {
  const byId = getAwardDefinition(award.awardDefinitionId);
  if (byId) return { award: byId, degreeId: award.degreeId };
  return resolveAwardName(award.name, award.year);
}

export function AwardsEditor({
  awards,
  onChange,
}: {
  awards: PersonAward[];
  onChange: (awards: PersonAward[]) => void;
}) {
  const [draftAward, setDraftAward] = useState<PersonAward | null>(null);
  const isExisting = !!draftAward && awards.some((award) => award.id === draftAward.id);
  const resolvedDraft = draftAward ? resolveStoredAward(draftAward) : undefined;
  const definition = resolvedDraft?.award;

  function startNew() {
    setDraftAward({ id: crypto.randomUUID(), name: "" });
  }

  function startEdit(award: PersonAward) {
    if (draftAward?.id === award.id) {
      setDraftAward(null);
      return;
    }
    setDraftAward(structuredClone(award));
  }

  function patchDraft(patch: Partial<PersonAward>) {
    setDraftAward((current) => (current ? { ...current, ...patch } : current));
  }

  function selectDefinition(definitionId: string) {
    if (!draftAward) return;
    if (!definitionId) {
      patchDraft({ awardDefinitionId: undefined, degreeId: undefined });
      return;
    }
    const selected = getAwardDefinition(definitionId);
    if (!selected) return;
    patchDraft({
      name: selected.name,
      awardDefinitionId: selected.id,
      degreeId: undefined,
    });
  }

  function updateName(name: string) {
    if (!draftAward) return;
    const resolved = resolveAwardName(
      name,
      draftAward.year,
      draftAward.awardDefinitionId,
    );
    patchDraft(
      resolved
        ? {
            name,
            awardDefinitionId: resolved.award.id,
            degreeId: resolved.degreeId,
          }
        : { name, awardDefinitionId: undefined, degreeId: undefined },
    );
  }

  function updateYear(year: string) {
    if (!draftAward) return;
    const resolved = resolveAwardName(
      draftAward.name,
      year || undefined,
      draftAward.awardDefinitionId,
    );
    patchDraft({
      year: year || undefined,
      awardDefinitionId: resolved?.award.id,
      degreeId: resolved?.degreeId || draftAward.degreeId,
    });
  }

  function commitDraft() {
    if (!draftAward?.name.trim()) return;
    const normalized: PersonAward = {
      ...draftAward,
      name: draftAward.name.trim(),
      source:
        draftAward.source?.title?.trim() || draftAward.source?.url?.trim()
          ? {
              title: draftAward.source?.title?.trim() || "",
              url: draftAward.source?.url?.trim() || undefined,
            }
          : undefined,
    };
    onChange(
      isExisting
        ? awards.map((award) => (award.id === normalized.id ? normalized : award))
        : [...awards, normalized],
    );
    setDraftAward(null);
  }

  function removeDraft() {
    if (draftAward && isExisting)
      onChange(awards.filter((award) => award.id !== draftAward.id));
    setDraftAward(null);
  }

  return (
    <section className="award-editor-compact" aria-label="Награды">
      <datalist id="award-catalog-suggestions">
        {AWARD_CATALOG.map((item) => (
          <option key={item.id} value={item.name}>
            {item.countryName}
          </option>
        ))}
      </datalist>

      <div className="award-editor-strip">
        {awards.map((award) => {
          const resolved = resolveStoredAward(award);
          const itemDefinition = resolved?.award;
          const degreeId = award.degreeId || resolved?.degreeId;
          const active = draftAward?.id === award.id;
          return (
            <button
              key={award.id}
              type="button"
              className={active ? "award-editor-chip is-active" : "award-editor-chip"}
              onClick={() => startEdit(award)}
              title={award.name}
              aria-label={`Редактировать: ${award.name}`}
            >
              <AwardVisual definition={itemDefinition} degreeId={degreeId} size={38} />
            </button>
          );
        })}
        {!draftAward && awards.length < 100 && (
          <button
            type="button"
            className="award-editor-add"
            onClick={startNew}
            aria-label="Добавить награду"
            title="Добавить награду"
          >
            <Plus size={19} />
          </button>
        )}
      </div>

      {draftAward && (
        <div className="award-inline-form">
          <div className="award-inline-head">
            <strong>{isExisting ? draftAward.name || "Награда" : "Новая награда"}</strong>
            <button
              type="button"
              className="award-inline-close"
              onClick={() => setDraftAward(null)}
              aria-label="Закрыть редактирование награды"
            >
              <X size={16} />
            </button>
          </div>

          <label>
            Каталог / страна
            <select
              value={draftAward.awardDefinitionId || ""}
              onChange={(event) => selectDefinition(event.target.value)}
            >
              <option value="">Автоопределение / своя запись</option>
              {AWARD_CATALOG.map((item) => (
                <option key={item.id} value={item.id}>
                  {item.name} — {item.countryName}
                </option>
              ))}
            </select>
          </label>

          <div className="award-name-year">
            <label>
              Название
              <input
                value={draftAward.name}
                list="award-catalog-suggestions"
                maxLength={300}
                placeholder="Например, медаль «За отвагу»"
                onChange={(event) => updateName(event.target.value)}
              />
            </label>
            <label>
              Год
              <input
                value={draftAward.year || ""}
                inputMode="numeric"
                maxLength={4}
                placeholder="1945"
                onChange={(event) => updateYear(event.target.value)}
              />
            </label>
          </div>

          {definition && (
            <div className="award-recognized">
              <AwardVisual
                definition={definition}
                degreeId={draftAward.degreeId || resolvedDraft?.degreeId}
                size={42}
              />
              <span>
                {definition.name}
                <br />
                <small>{definition.countryName}</small>
              </span>
            </div>
          )}

          {definition?.degrees && (
            <label>
              Степень
              <select
                value={draftAward.degreeId || resolvedDraft?.degreeId || ""}
                onChange={(event) =>
                  patchDraft({ degreeId: event.target.value || undefined })
                }
              >
                <option value="">Не указана</option>
                {definition.degrees.map((degree) => (
                  <option key={degree.id} value={degree.id}>
                    {degree.label}
                  </option>
                ))}
              </select>
            </label>
          )}

          <details className="award-source-editor">
            <summary>Источник</summary>
            <label>
              Описание
              <input
                value={draftAward.source?.title || ""}
                maxLength={2000}
                placeholder="Наградной лист, архивный шифр…"
                onChange={(event) =>
                  patchDraft({
                    source:
                      event.target.value || draftAward.source?.url
                        ? { ...draftAward.source, title: event.target.value }
                        : undefined,
                  })
                }
              />
            </label>
            <label>
              Ссылка
              <input
                value={draftAward.source?.url || ""}
                maxLength={2048}
                placeholder="https://…"
                onChange={(event) =>
                  patchDraft({
                    source:
                      event.target.value || draftAward.source?.title
                        ? {
                            title: draftAward.source?.title || "",
                            url: event.target.value,
                          }
                        : undefined,
                  })
                }
              />
            </label>
          </details>

          <div className="award-inline-actions">
            <button
              type="button"
              className="award-inline-primary"
              disabled={!draftAward.name.trim()}
              onClick={commitDraft}
            >
              <Check size={15} /> {isExisting ? "Готово" : "Добавить"}
            </button>
            {isExisting && (
              <button type="button" className="award-remove" onClick={removeDraft}>
                <Trash2 size={14} /> Удалить
              </button>
            )}
          </div>
        </div>
      )}
    </section>
  );
}

export function PersonAwards({ awards }: { awards?: PersonAward[] }) {
  const [pinnedAwardId, setPinnedAwardId] = useState<string | null>(null);
  const [hoveredAwardId, setHoveredAwardId] = useState<string | null>(null);

  if (!awards?.length) return null;

  const items = awards.map((award) => {
    const resolved = resolveStoredAward(award);
    const definition = resolved?.award;
    const degreeId = award.degreeId || resolved?.degreeId;
    const degree = definition?.degrees?.find((item) => item.id === degreeId);
    return {
      award,
      definition,
      degreeId,
      degree,
      url: safeUrl(award.source?.url),
    };
  });

  const activeAwardId = hoveredAwardId || pinnedAwardId;
  const active = items.find((item) => item.award.id === activeAwardId);

  return (
    <section
      className="person-awards"
      aria-label="Награды человека"
      onMouseLeave={() => setHoveredAwardId(null)}
      onBlurCapture={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node | null))
          setHoveredAwardId(null);
      }}
    >
      <ul className="award-stack" aria-label="Награды">
        {items.map((item, index) => {
          const isActive = item.award.id === activeAwardId;
          const isPinned = item.award.id === pinnedAwardId;
          const meta = [item.degree?.label, item.award.year, item.definition?.countryName]
            .filter(Boolean)
            .join(" · ");
          return (
            <li
              key={item.award.id}
              className={isActive ? "award-stack-item is-active" : "award-stack-item"}
              style={{ zIndex: isActive ? items.length + 2 : index + 1 }}
            >
              <button
                type="button"
                className="award-medal-button"
                aria-expanded={isActive}
                aria-pressed={isPinned}
                aria-controls="active-award-details"
                aria-label={[item.award.name, meta].filter(Boolean).join(", ")}
                onMouseEnter={() => setHoveredAwardId(item.award.id)}
                onFocus={() => setHoveredAwardId(item.award.id)}
                onClick={() => {
                  const closing = pinnedAwardId === item.award.id;
                  setPinnedAwardId(closing ? null : item.award.id);
                  if (closing) setHoveredAwardId(null);
                }}
              >
                <span className="award-visual" aria-hidden="true">
                  <AwardVisual
                    definition={item.definition}
                    degreeId={item.degreeId}
                    size={50}
                  />
                </span>
              </button>
            </li>
          );
        })}
      </ul>

      {active && (
        <div id="active-award-details" className="award-focus-card">
          <strong>{active.award.name}</strong>
          <div className="award-focus-meta">
            {active.degree?.label && <span>{active.degree.label}</span>}
            {active.award.year && <span>{active.award.year}</span>}
            {active.definition?.countryName && <span>{active.definition.countryName}</span>}
          </div>
          {(active.award.source?.title || active.url) && (
            <div className="award-focus-source">
              {active.award.source?.title && <p>{active.award.source.title}</p>}
              {active.url && (
                <a href={active.url} target="_blank" rel="noopener noreferrer">
                  Открыть источник <ArrowUpRight size={13} />
                </a>
              )}
            </div>
          )}
        </div>
      )}
    </section>
  );
}
