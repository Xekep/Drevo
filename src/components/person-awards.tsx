import { useEffect, useId, useRef, useState } from "react";
import { ArrowUpRight, Check, Medal, Plus, Trash2, X } from "lucide-react";
import type { PersonAward } from "../domain/types";
import { safeUrl } from "../domain";
import { archiveResourceUrl } from "../domain/archive-context.ts";
import { scopedArchivePath } from "../domain/archive-context.ts";
import { archiveDocumentPath } from "../domain/archive-routes.ts";
import { CitationSourcesEditor } from "./union-sources-editor.tsx";
import { DocumentSourcePicker } from "./document-source-picker.tsx";
import {
  activeInYear,
  getAwardDefinition,
  resolveAwardName,
  searchAwards,
} from "../features/awards/catalog/index.ts";
import type { AwardDefinition } from "../features/awards/types.ts";

const loadedAwardImages = new Set<string>();
const failedAwardImages = new Set<string>();

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
  const src = image?.src;
  const [readySrc, setReadySrc] = useState<string | undefined>(() =>
    src && loadedAwardImages.has(src) ? src : undefined,
  );
  const [failedSrc, setFailedSrc] = useState<string | undefined>(() =>
    src && failedAwardImages.has(src) ? src : undefined,
  );

  useEffect(() => {
    if (!src || loadedAwardImages.has(src) || failedAwardImages.has(src))
      return;
    let active = true;
    const preload = new Image();
    preload.decoding = "async";
    const ready = async () => {
      try {
        await preload.decode();
      } catch {
        // Некоторые браузеры отклоняют decode() после onload, хотя файл уже готов.
      }
      if (!active) return;
      if (preload.naturalWidth > 0) {
        loadedAwardImages.add(src);
        setReadySrc(src);
      } else {
        failedAwardImages.add(src);
        setFailedSrc(src);
      }
    };
    preload.onload = () => void ready();
    preload.onerror = () => {
      if (!active) return;
      failedAwardImages.add(src);
      setFailedSrc(src);
    };
    preload.src = src;
    if (preload.complete && preload.naturalWidth > 0) void ready();
    return () => {
      active = false;
      preload.onload = null;
      preload.onerror = null;
    };
  }, [src]);

  if (src && (readySrc === src || loadedAwardImages.has(src))) {
    return (
      <img
        src={src}
        alt=""
        width={size}
        height={size}
        decoding="async"
        className="award-image-ready"
        onError={() => {
          loadedAwardImages.delete(src);
          failedAwardImages.add(src);
          setFailedSrc(src);
        }}
        style={{
          width: size,
          height: size,
          objectFit: "contain",
          background: "transparent",
        }}
      />
    );
  }

  if (src && failedSrc !== src && !failedAwardImages.has(src)) {
    return (
      <span
        className="award-loading-placeholder"
        aria-hidden="true"
        style={{ width: size, height: size }}
      >
        <Medal
          size={Math.max(22, Math.round(size * 0.56))}
          strokeWidth={1.15}
        />
      </span>
    );
  }

  return (
    <Medal size={Math.max(24, Math.round(size * 0.62))} strokeWidth={1.4} />
  );
}

function resolveStoredAward(award: PersonAward) {
  const byId = getAwardDefinition(award.awardDefinitionId);
  if (byId) return { award: byId, degreeId: award.degreeId };
  return resolveAwardName(award.name, award.year);
}

function needsSourceChoice(previous: PersonAward | undefined, next: PersonAward) {
  if (!previous) return false;
  const before = resolveStoredAward(previous);
  const after = resolveStoredAward(next);
  const sameIdentity = before?.award.id && after?.award.id
    ? before.award.id === after.award.id &&
      (previous.degreeId || before.degreeId || "") === (next.degreeId || after.degreeId || "")
    : previous.name.trim().replace(/\s+/g, " ").toLocaleLowerCase("ru") ===
      next.name.trim().replace(/\s+/g, " ").toLocaleLowerCase("ru");
  return !sameIdentity && (retainedLegacySource(previous, next) ||
    (next.sources || []).some((source) => (previous.sources || []).some((old) =>
      JSON.stringify(old) === JSON.stringify(source))));
}

function retainedLegacySource(previous: PersonAward, next: PersonAward) {
  return Boolean(previous.source && (previous.source.title.trim() || previous.source.url?.trim()) &&
    previous.source.title.trim() === (next.source?.title || "").trim() &&
    (previous.source.url || "").trim() === (next.source?.url || "").trim());
}

export function AwardsEditor({
  awards,
  onChange,
  personId,
  isAdmin,
}: {
  awards: PersonAward[];
  onChange: (awards: PersonAward[]) => void;
  personId?: string;
  isAdmin: boolean;
}) {
  const [draftAward, setDraftAward] = useState<PersonAward | null>(null);
  const [sourceChoiceOpen, setSourceChoiceOpen] = useState(false);
  const retainSourceRef = useRef<HTMLButtonElement>(null);
  const doneRef = useRef<HTMLButtonElement>(null);
  const returnToDoneRef = useRef(false);
  const [showSuggestions, setShowSuggestions] = useState(false);
  const [activeSuggestion, setActiveSuggestion] = useState(0);
  const nameInputId = useId();
  const sourceQuestionId = useId();
  const suggestionsId = `${nameInputId}-suggestions`;
  useEffect(() => {
    if (sourceChoiceOpen) retainSourceRef.current?.focus();
    else if (returnToDoneRef.current) {
      returnToDoneRef.current = false;
      doneRef.current?.focus();
    }
  }, [sourceChoiceOpen]);
  const isExisting =
    !!draftAward && awards.some((award) => award.id === draftAward.id);
  const choiceHasCitations = Boolean(draftAward && awards.find((award) =>
    award.id === draftAward.id)?.sources?.length);
  const resolvedDraft = draftAward ? resolveStoredAward(draftAward) : undefined;
  const definition = resolvedDraft?.award;
  const suggestions =
    draftAward && draftAward.name.trim().length >= 2
      ? searchAwards(draftAward.name)
          .filter((award) => activeInYear(award, draftAward.year))
          .slice(0, 8)
      : [];
  const suggestionsOpen = showSuggestions && suggestions.length > 0;

  function startNew() {
    setDraftAward({ id: crypto.randomUUID(), name: "" });
    setSourceChoiceOpen(false);
    setShowSuggestions(false);
  }

  function startEdit(award: PersonAward) {
    if (draftAward?.id === award.id) {
      setDraftAward(null);
      return;
    }
    setDraftAward(structuredClone(award));
    setSourceChoiceOpen(false);
    setShowSuggestions(false);
  }

  function patchDraft(patch: Partial<PersonAward>) {
    setSourceChoiceOpen(false);
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
    setShowSuggestions(false);
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
    setActiveSuggestion(0);
    setShowSuggestions(true);
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
      degreeId:
        resolved?.award.id === draftAward.awardDefinitionId
          ? draftAward.degreeId || resolved?.degreeId
          : resolved?.degreeId,
    });
  }

  function commitDraft(sourceDecision?: "retain" | "remove") {
    if (!draftAward?.name.trim()) return;
    const previous = awards.find((award) => award.id === draftAward.id);
    if (!sourceDecision && needsSourceChoice(previous, draftAward)) {
      setSourceChoiceOpen(true);
      return;
    }
    const removeLegacy = sourceDecision === "remove" && previous &&
      retainedLegacySource(previous, draftAward);
    const sources = sourceDecision === "remove" && previous
      ? draftAward.sources?.filter((source) => !(previous.sources || []).some((old) =>
          JSON.stringify(old) === JSON.stringify(source)))
      : draftAward.sources;
    const normalized: PersonAward = {
      ...draftAward,
      name: draftAward.name.trim(),
      sources,
      source:
        !removeLegacy && (draftAward.source?.title?.trim() || draftAward.source?.url?.trim())
          ? {
              title: draftAward.source?.title?.trim() || "",
              url: draftAward.source?.url?.trim() || undefined,
            }
          : undefined,
    };
    onChange(
      isExisting
        ? awards.map((award) =>
            award.id === normalized.id ? normalized : award,
          )
        : [...awards, normalized],
    );
    setDraftAward(null);
    setSourceChoiceOpen(false);
  }

  function removeDraft() {
    if (draftAward && isExisting)
      onChange(awards.filter((award) => award.id !== draftAward.id));
    setDraftAward(null);
    setSourceChoiceOpen(false);
  }

  return (
    <section className="award-editor-compact" aria-label="Награды">
      <span className="award-editor-title">Награды</span>
      {(awards.length > 0 || !draftAward) && (
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
                className={
                  active ? "award-editor-chip is-active" : "award-editor-chip"
                }
                onClick={() => startEdit(award)}
                title={award.name}
                aria-label={`Редактировать: ${award.name}`}
              >
                <AwardVisual
                  definition={itemDefinition}
                  degreeId={degreeId}
                  size={38}
                />
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
      )}

      {draftAward && (
        <div className="award-inline-form">
          <div className="award-inline-head">
            <strong>
              {isExisting ? draftAward.name || "Награда" : "Новая награда"}
            </strong>
            <button
              type="button"
              className="award-inline-close"
              onClick={() => setDraftAward(null)}
              aria-label="Закрыть редактирование награды"
            >
              <X size={16} />
            </button>
          </div>

          <div className="award-name-year">
            <div
              className="award-name-field"
              onBlurCapture={(event) => {
                if (
                  !event.currentTarget.contains(
                    event.relatedTarget as Node | null,
                  )
                )
                  setShowSuggestions(false);
              }}
            >
              <label htmlFor={nameInputId}>Название</label>
              <input
                id={nameInputId}
                value={draftAward.name}
                role="combobox"
                aria-autocomplete="list"
                aria-expanded={suggestionsOpen}
                aria-controls={suggestionsId}
                aria-activedescendant={
                  suggestionsOpen
                    ? `${suggestionsId}-${activeSuggestion}`
                    : undefined
                }
                maxLength={300}
                placeholder="Например, медаль «За отвагу»"
                onChange={(event) => updateName(event.target.value)}
                onFocus={() => setShowSuggestions(true)}
                onKeyDown={(event) => {
                  if (event.key === "Escape" && suggestionsOpen) {
                    event.preventDefault();
                    event.stopPropagation();
                    setShowSuggestions(false);
                  }
                  if (event.key === "ArrowDown" && suggestionsOpen) {
                    event.preventDefault();
                    setActiveSuggestion(
                      (index) => (index + 1) % suggestions.length,
                    );
                  }
                  if (event.key === "ArrowUp" && suggestionsOpen) {
                    event.preventDefault();
                    setActiveSuggestion(
                      (index) =>
                        (index - 1 + suggestions.length) % suggestions.length,
                    );
                  }
                  if (event.key === "Enter") {
                    event.preventDefault();
                    if (suggestionsOpen)
                      selectDefinition(suggestions[activeSuggestion].id);
                  }
                }}
              />
              {suggestionsOpen && (
                <div
                  id={suggestionsId}
                  role="listbox"
                  className="award-suggestions"
                >
                  {suggestions.map((award, index) => (
                    <button
                      key={award.id}
                      id={`${suggestionsId}-${index}`}
                      type="button"
                      role="option"
                      aria-selected={index === activeSuggestion}
                      className={index === activeSuggestion ? "is-active" : ""}
                      onMouseDown={(event) => event.preventDefault()}
                      onClick={() => selectDefinition(award.id)}
                    >
                      <span>{award.name}</span>
                      <small>{award.countryName}</small>
                    </button>
                  ))}
                </div>
              )}
            </div>
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
            <summary>Описание и ссылка</summary>
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

          <details className="award-source-editor">
            <summary>Цитаты и документы ({draftAward.sources?.length || 0})</summary>
            <CitationSourcesEditor sources={draftAward.sources || []}
              isAdmin={isAdmin} onChange={(sources) => patchDraft({ sources })} />
            {(draftAward.sources || []).map((source, index) =>
              <div key={`${draftAward.id}-${index}`} aria-label={`Документ цитаты ${index + 1}`}>
                {source.catalogId ? <>
                  {source.documentId && <a
                    href={scopedArchivePath(archiveDocumentPath(null, source.documentId, source.documentPage))}
                    target="_blank" rel="noopener noreferrer">Открыть документ источника</a>}
                  {isAdmin && source.documentId && <label>Страница документа источника
                    <input type="number" min={1} max={2000} value={source.documentPage ?? ""}
                      onChange={(event) => {
                        const value = Number(event.target.value);
                        patchDraft({ sources: draftAward.sources?.map((item, i) => i === index
                          ? { ...item, documentPage: event.target.value && Number.isInteger(value) &&
                            value >= 1 && value <= 2000 ? value : undefined }
                          : item) });
                      }} />
                  </label>}
                </> : <DocumentSourcePicker personId={personId}
                  documentId={source.documentId} pageNumber={source.documentPage}
                  onChange={(document) => patchDraft({ sources: draftAward.sources?.map((item, i) =>
                    i === index ? { ...item, title: item.title || document?.title || "",
                      documentId: document?.id,
                      documentPage: document?.id === item.documentId ? item.documentPage : undefined } : item) })}
                  onPageChange={(documentPage) => patchDraft({ sources: draftAward.sources?.map((item, i) =>
                    i === index ? { ...item, documentPage } : item) })} />}
              </div>)}
          </details>

          {sourceChoiceOpen && (
            <div className="award-source-choice" role="group" aria-label="Источник прежней награды" aria-describedby={sourceQuestionId}>
              <p id={sourceQuestionId}>{choiceHasCitations
                ? "Вы выбрали другую награду. Прежние цитаты могли подтверждать только старую. Оставить их для новой награды?"
                : "Вы выбрали другую награду. Прежний источник мог подтверждать только старую. Оставить его для новой награды?"}</p>
              <div className="award-source-choice-actions">
                <button ref={retainSourceRef} type="button" onClick={() => commitDraft("retain")}>{choiceHasCitations ? "Оставить цитаты" : "Оставить источник"}</button>
                <button type="button" onClick={() => commitDraft("remove")}>{choiceHasCitations ? "Убрать прежние цитаты" : "Убрать источник"}</button>
                <button type="button" onClick={() => {
                  returnToDoneRef.current = true;
                  setSourceChoiceOpen(false);
                }}>Вернуться к награде</button>
              </div>
            </div>
          )}
          {!sourceChoiceOpen && <div className="award-inline-actions">
            <button
              ref={doneRef}
              type="button"
              className="award-inline-primary"
              disabled={!draftAward.name.trim()}
              onClick={() => commitDraft()}
            >
              <Check size={15} /> {isExisting ? "Готово" : "Добавить"}
            </button>
            {isExisting && (
              <button
                type="button"
                className="award-remove"
                onClick={removeDraft}
              >
                <Trash2 size={14} /> Удалить
              </button>
            )}
          </div>}
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
      visualImage: degree?.image || definition?.image,
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
          const meta = [
            item.degree?.label,
            item.award.year,
            item.definition?.countryName,
          ]
            .filter(Boolean)
            .join(" · ");
          return (
            <li
              key={item.award.id}
              className={
                isActive ? "award-stack-item is-active" : "award-stack-item"
              }
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
                <span
                  className="award-visual"
                  aria-hidden="true"
                  style={{ animationDelay: `${Math.min(index, 6) * 55}ms` }}
                >
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
            {active.definition?.countryName && (
              <span>{active.definition.countryName}</span>
            )}
          </div>
          {(active.award.source?.title || active.url) && (
            <div className="award-focus-source">
              {active.award.source?.title && <p>{active.award.source.title}</p>}
              {active.url && (
                <a href={archiveResourceUrl(active.url)} target="_blank" rel="noopener noreferrer">
                  Открыть источник <ArrowUpRight size={13} />
                </a>
              )}
            </div>
          )}
          {active.award.sources?.map((source, index) => {
            const url = safeUrl(source.url);
            return <div className="award-focus-source" key={index}>
              <p>{[source.title, source.reference].filter(Boolean).join(" · ")}</p>
              {url && <a href={archiveResourceUrl(url)} target="_blank" rel="noopener noreferrer">
                Открыть источник <ArrowUpRight size={13} />
              </a>}
              {source.documentId && <a
                href={scopedArchivePath(archiveDocumentPath(null, source.documentId, source.documentPage))}
                target="_blank" rel="noopener noreferrer">Открыть документ{source.documentPage
                  ? ` · стр. ${source.documentPage}` : ""}</a>}
            </div>;
          })}
          {active.visualImage && (
            <a
              className="award-image-credit"
              href={active.visualImage.sourcePage}
              target="_blank"
              rel="noopener noreferrer"
            >
              Изображение: {active.visualImage.author || "Wikimedia Commons"} · {active.visualImage.license}
              <ArrowUpRight size={12} aria-hidden="true" />
            </a>
          )}
        </div>
      )}
    </section>
  );
}
