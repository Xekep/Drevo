import { useState } from "react";
import { ArrowUpRight, Medal, Plus, Trash2 } from "lucide-react";
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
  function update(id: string, patch: Partial<PersonAward>) {
    onChange(
      awards.map((award) => (award.id === id ? { ...award, ...patch } : award)),
    );
  }

  function selectDefinition(id: string, definitionId: string) {
    const current = awards.find((award) => award.id === id);
    if (!current) return;

    if (!definitionId) {
      update(id, { awardDefinitionId: undefined, degreeId: undefined });
      return;
    }

    const definition = getAwardDefinition(definitionId);
    if (!definition) return;
    update(id, {
      name: definition.name,
      awardDefinitionId: definition.id,
      degreeId: undefined,
    });
  }

  function updateName(id: string, name: string) {
    const current = awards.find((award) => award.id === id);
    const resolved = resolveAwardName(
      name,
      current?.year,
      current?.awardDefinitionId,
    );
    update(
      id,
      resolved
        ? {
            name,
            awardDefinitionId: resolved.award.id,
            degreeId: resolved.degreeId,
          }
        : { name, awardDefinitionId: undefined, degreeId: undefined },
    );
  }

  function updateYear(id: string, year: string) {
    const current = awards.find((award) => award.id === id);
    if (!current) return;
    const resolved = resolveAwardName(
      current.name,
      year || undefined,
      current.awardDefinitionId,
    );
    update(id, {
      year: year || undefined,
      awardDefinitionId: resolved?.award.id,
      degreeId: resolved?.degreeId || current.degreeId,
    });
  }

  return (
    <details className="form-details award-editor">
      <summary>Награды{awards.length ? ` · ${awards.length}` : ""}</summary>
      <datalist id="award-catalog-suggestions">
        {AWARD_CATALOG.map((definition) => (
          <option key={definition.id} value={definition.name}>
            {definition.countryName}
          </option>
        ))}
      </datalist>
      {awards.map((award, i) => {
        const resolved = resolveStoredAward(award);
        const definition = resolved?.award;
        return (
          <fieldset key={award.id}>
            <legend>Награда {i + 1}</legend>
            <label>
              Награда из каталога
              <select
                value={award.awardDefinitionId || ""}
                onChange={(e) => selectDefinition(award.id, e.target.value)}
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
                  value={award.name}
                  list="award-catalog-suggestions"
                  maxLength={300}
                  placeholder="Например, медаль «За отвагу»"
                  onChange={(e) => updateName(award.id, e.target.value)}
                />
                {definition && (
                  <span className="award-recognized">
                    <AwardVisual
                      definition={definition}
                      degreeId={award.degreeId || resolved?.degreeId}
                      size={46}
                    />
                    <span>
                      Распознана: {definition.name}
                      <br />
                      <small>{definition.countryName}</small>
                    </span>
                  </span>
                )}
              </label>
              <label>
                Год
                <input
                  value={award.year || ""}
                  inputMode="numeric"
                  maxLength={4}
                  placeholder="1945"
                  onChange={(e) => updateYear(award.id, e.target.value)}
                />
              </label>
            </div>
            {definition?.degrees && (
              <label>
                Степень
                <select
                  value={award.degreeId || resolved?.degreeId || ""}
                  onChange={(e) =>
                    update(award.id, { degreeId: e.target.value || undefined })
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
            <label>
              Источник
              <input
                value={award.source?.title || ""}
                maxLength={2000}
                placeholder="Наградной лист, архивный шифр, семейное свидетельство…"
                onChange={(e) =>
                  update(award.id, {
                    source:
                      e.target.value || award.source?.url
                        ? { ...award.source, title: e.target.value }
                        : undefined,
                  })
                }
              />
            </label>
            <label>
              Ссылка на источник, если есть
              <input
                value={award.source?.url || ""}
                maxLength={2048}
                placeholder="https://…"
                onChange={(e) =>
                  update(award.id, {
                    source:
                      e.target.value || award.source?.title
                        ? {
                            title: award.source?.title || "",
                            url: e.target.value.trim() || undefined,
                          }
                        : undefined,
                  })
                }
              />
            </label>
            <button
              type="button"
              className="award-remove"
              onClick={() =>
                onChange(awards.filter((item) => item.id !== award.id))
              }
            >
              <Trash2 size={14} /> Убрать награду
            </button>
          </fieldset>
        );
      })}
      <button
        type="button"
        className="award-add"
        disabled={awards.length >= 100}
        onClick={() =>
          onChange([...awards, { id: crypto.randomUUID(), name: "" }])
        }
      >
        <Plus size={15} /> Добавить награду
      </button>
    </details>
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
      <h3>Награды</h3>
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
