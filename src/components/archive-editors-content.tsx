import { useEffect, useRef, useState, useId, type FormEvent } from "react";
import { PersonDocumentsEditor } from "./person-documents-editor";
import { DocumentSourcePicker } from "./document-source-picker";
import { SourceRepositoryEditor } from "./source-repository-editor.tsx";
import { archiveResourceUrl, scopedArchivePath } from "../domain/archive-context.ts";
import { archiveDocumentPath } from "../domain/archive-routes.ts";
import { CatalogPicker, CitationSourcesEditor } from "./union-sources-editor.tsx";
import { sourceCitation } from "../shared/source-catalog.ts";
import { PersonAlternativeClaims } from "./person-alternative-claims.tsx";
import {
  Pencil,
  UserRound,
  Trash2,
  Undo2,
  CalendarDays,
  BookOpen,
  Files,
  UsersRound,
  ContactRound,
} from "lucide-react";
import { canAssessArchiveEvidence } from "../domain";
import "../styles/person-editor.css";
import {
  availableColumn,
  connectPeople,
  CONNECTION_NAMES,
  fullName,
  plural,
  splitFullName,
  normalizeDateInput,
  dateInputLabel,
  guessSex,
  editorParentHints,
  siblingHints,
  birthSurnameHints,
  deceasedStatusSuggestion,
  removePerson,
  safeUrl,
  type Connection,
  type ConnectionType,
  type Family,
  type Person,
  type PersonValueClaim,
  type ClaimConfidence,
  CLAIM_CONFIDENCE_LABELS,
  type TwinKind,
  type ArchiveUser,
  owns,
} from "../domain";
import { EditorDialog } from "./editor-dialog";
import { PlaceField } from "./place-field";
import { AwardsEditor } from "./person-awards";
import { EventsEditor } from "./person-events";
import { SiblingSuggestions } from "./sibling-suggestions";
import { PortraitCropper } from "./portrait-cropper";
import { photoLabel } from "../domain/photo-metadata";
import { mediaPreview } from "../domain/media-preview";
import { applyPersonDraft, rebasePersonDraft } from "../domain/person-draft";
import { preserveBirthSurnameClaim, preserveOccupationClaim } from "../domain/person-fact-alternatives";
import {
  confirmDiscardChanges,
  useUnsavedChanges,
} from "../hooks/useUnsavedChanges";
type Save = (data: Family) => Promise<Family>;
function ValueClaimSourcesEditor({ kind, subject, value, claim, onChange,
  onPreservePrevious, isAdmin, canAssess }: {
  kind: "birth" | "death" | "occupation";
  subject: "date" | "place" | "occupation" | "surname";
  value: string;
  claim?: PersonValueClaim;
  onChange: (claim: PersonValueClaim | undefined) => void;
  onPreservePrevious?: () => void;
  isAdmin: boolean;
  canAssess: boolean;
}) {
  // Imported and previously recorded claims remain editable, but ordinary
  // person fields no longer offer creation of a field-specific citation.
  if (!claim) return null;
  const occupation = subject === "occupation";
  const surname = subject === "surname";
  const label = kind === "birth" ? "рождения" : "смерти";
  const subjectLabel = subject === "date" ? "даты" : "места";
  const title = occupation ? "Источники занятия" : surname
    ? "Источники фамилии при рождении" : `Источники ${subjectLabel} ${label}`;
  return <details className={`form-details ${occupation ? "occupation-claim" : surname
    ? "birth-surname-claim" : `${kind}-${subject}-claim`}`}>
    <summary>{title}{claim?.sources.length ? ` · ${claim.sources.length}` : ""}</summary>
    {claim && claim.value !== value
      ? <div>
          <p role="alert">{occupation ? "Занятие изменилось. Источники относятся к прежнему занятию " : surname ? "Фамилия изменилась. Источники относятся к прежней фамилии при рождении " : subject === "date" ? "Дата изменилась. Источники относятся к прежней дате " : "Место изменилось. Источники относятся к прежнему месту "}{subject === "date" ? dateInputLabel(claim.value) : claim.value}. {claim.confidence && !canAssess
            ? "Верните прежнее значение перед сохранением или попросите исследователя снять оценку."
            : onPreservePrevious
              ? occupation
                ? "Сохраните прежнее занятие как вариант, снимите связь или верните прежнее значение перед сохранением."
                : "Сохраните прежнюю фамилию как вариант, снимите связь или верните прежнее значение перед сохранением."
              : "Снимите связь или верните прежнее значение перед сохранением."}</p>
          {claim.confidence && !canAssess
            ? <p>Оценку и связь с прежним значением может снять только исследователь или администратор.</p>
            : <>
                {onPreservePrevious && <button type="button" onClick={onPreservePrevious}>
                  {occupation ? "Сохранить прежнее занятие с источниками как вариант" :
                    "Сохранить прежнюю фамилию с источниками как вариант"}
                </button>}
                <button type="button" onClick={() => onChange(undefined)}>Снять связи с прежн{subject === "date" ? "ей датой" : occupation ? "им занятием" : surname ? "ей фамилией" : "им местом"}</button>
              </>}
        </div>
      : value.trim()
        ? <>
            <CitationSourcesEditor
              allowAdd={false}
              sources={claim?.sources || []}
              onChange={(sources) => onChange(sources.length
                ? { ...claim, value, sources } : undefined)}
              isAdmin={isAdmin}
              canRemoveLast={!claim?.confidence || canAssess}
            />
            {claim && <label>
              Достоверность
              <select
                value={claim.confidence || ""}
                disabled={!canAssess}
                onChange={(event) => onChange({ ...claim,
                  confidence: event.target.value ? event.target.value as ClaimConfidence : undefined })}
              >
                <option value="">Не оценено</option>
                {(Object.keys(CLAIM_CONFIDENCE_LABELS) as ClaimConfidence[]).map((status) =>
                  <option key={status} value={status}>{CLAIM_CONFIDENCE_LABELS[status]}</option>)}
              </select>
              <small>Оценка исследователя; добавление источника не повышает её автоматически.</small>
              {!canAssess && claim.confidence &&
                <small>Удалить последний источник и оценку может только исследователь или администратор.</small>}
            </label>}
          </>
        : <p>{occupation ? "Укажите занятие, чтобы привязать к нему источник." : surname
          ? "Укажите фамилию при рождении, чтобы привязать к ней источник."
          : `Укажите ${subject === "date" ? "дату" : "место"} ${label}, чтобы привязать к ${subject === "date" ? "ней" : "нему"} источник.`}</p>}
  </details>;
}
export function PersonEditor({
  isAdmin,
  user,
  relativeTo,
  uploadPortrait,
  family,
  person,
  save,
  onClose,
  onSaved,
  onDirtyChange,
  busy,
  inline = false,
  suspended = false,
  initialRelationship = "child",
}: {
  family: Family;
  person?: Person;
  isAdmin: boolean;
  user: ArchiveUser | null;
  relativeTo?: Person;
  uploadPortrait: (file: File) => Promise<string>;
  save: Save;
  onClose: () => void;
  onSaved: (id: string) => void;
  onDirtyChange?: (dirty: boolean) => void;
  busy: boolean;
  inline?: boolean;
  suspended?: boolean;
  initialRelationship?: "child" | ConnectionType;
}) {
  const [draft, setDraft] = useState<Person>(() =>
    person
      ? structuredClone(person)
      : {
          id: crypto.randomUUID(),
          name: "",
          surname: "",
          patronymic: "",
          sex: "u",
          birth: "",
          birthPlace: "",
          parents: [],
          spouses: [],
          generation: 1,
          column: 0,
          sources: [],
        },
  );
  const [error, setError] = useState(""),
    [confirm, setConfirm] = useState(false);
  const [nameText, setNameText] = useState(person ? fullName(person) : "");
  const [autoSex, setAutoSex] = useState(!person || person.sex === "u");
  const [accepted, setAccepted] = useState<string[]>([]);
  const [birthText, setBirthText] = useState(
    dateInputLabel(person?.birth || ""),
  );
  const [deathText, setDeathText] = useState(
    dateInputLabel(person?.death || ""),
  );
  const hintDate = (value: string) => {
    try {
      return normalizeDateInput(value);
    } catch {
      return "";
    }
  };
  const [portraitFile, setPortraitFile] = useState<File | null>(null),
    [portraitPreview, setPortraitPreview] = useState(""),
    [relationship, setRelationship] = useState<"child" | ConnectionType>(
      initialRelationship,
    );
  const [twinKind, setTwinKind] = useState<TwinKind>("unknown");
  const [galleryOpen, setGalleryOpen] = useState(false),
    [cropSource, setCropSource] = useState("");
  const [removedConnections, setRemovedConnections] = useState<Connection[]>(
    [],
  );
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const formRef = useRef<HTMLFormElement>(null);
  const fieldId = useId();
  const snapshot = JSON.stringify([
    draft,
    nameText,
    birthText,
    deathText,
    autoSex,
    relationship,
    twinKind,
    accepted,
    removedConnections,
    !!portraitFile,
  ]);
  const [initialSnapshot] = useState(snapshot);
  const dirty = initialSnapshot !== snapshot;
  useUnsavedChanges(dirty);
  useEffect(() => {
    onDirtyChange?.(dirty);
  }, [dirty, onDirtyChange]);
  const close = () => {
    if (busy || !confirmDiscardChanges(dirty)) return;
    onDirtyChange?.(false);
    onClose();
  };
  function validateField(key: "name" | "birth" | "death", value: string) {
    let problem = "";
    try {
      if (key === "name") {
        const parts = splitFullName(value);
        if (!parts.name.trim() || !parts.surname.trim())
          problem = "Укажите фамилию и имя. Отчество необязательно.";
      } else normalizeDateInput(value);
    } catch (error) {
      problem = (error as Error).message;
    }
    setFieldErrors((current) => ({ ...current, [key]: problem }));
    return problem;
  }
  const portraitPhotos = (family.photos || []).filter((photo) =>
    photo.tags.some((tag) => tag.personId === draft.id),
  );
  const relativeSex = relativeTo
      ? relativeTo.sex === "u"
        ? guessSex(relativeTo)
        : relativeTo.sex
      : "u",
    relationshipSex =
      !person && relationship === "spouse" && relativeSex !== "u"
        ? relativeSex === "m"
          ? "f"
          : "m"
        : "u",
    suggestedSex = relationshipSex !== "u" ? relationshipSex : guessSex(draft);
  const nameParts = nameText.trim().split(/\s+/);
  const possibleReversedName = nameParts.length === 2 &&
    guessSex(draft) === "u" &&
    guessSex({ name: nameParts[0], patronymic: "" }) !== "u" &&
    guessSex({ name: nameParts[1], patronymic: "" }) === "u";
  const hintDraft = {
    ...draft,
    birth: hintDate(birthText),
    death: hintDate(deathText) || undefined,
    sex: autoSex ? suggestedSex : draft.sex,
    parents:
      !person && relativeTo && relationship === "child"
        ? [...draft.parents, relativeTo.id]
        : draft.parents,
    spouses:
      !person && relativeTo && relationship === "spouse"
        ? [...new Set([...draft.spouses, relativeTo.id])]
        : draft.spouses,
  };
  const deceasedHint =
    !person && !deathText.trim()
      ? deceasedStatusSuggestion(family, hintDraft)
      : null;
  const suggestions = editorParentHints(
    hintDraft,
    family.people,
    accepted,
    family.links,
  ).filter(
    (hint) =>
      (hint.to === draft.id || owns(user, hint.person)) &&
      !(relativeTo && relationship === "parent" && hint.to === relativeTo.id),
  );
  const confirmed = suggestions.filter((hint) =>
    accepted.includes(`${hint.from}:${hint.to}`),
  );
  const siblings = siblingHints(
    {
      ...hintDraft,
      parents: [
        ...hintDraft.parents,
        ...confirmed.filter((h) => h.to === draft.id).map((h) => h.from),
      ],
    },
    family.people,
    family.links,
  );
  const surnames = birthSurnameHints(
    {
      ...hintDraft,
      parents: [
        ...hintDraft.parents,
        ...confirmed.filter((h) => h.to === draft.id).map((h) => h.from),
      ],
    },
    family.people,
  );
  useEffect(
    () => () => {
      if (portraitPreview) URL.revokeObjectURL(portraitPreview);
    },
    [portraitPreview],
  );
  function field(key: keyof Person, value: unknown) {
    const next = { ...draft, [key]: value };
    setDraft(next);
    if (["name", "surname", "patronymic"].includes(key))
      setNameText(fullName(next));
  }
  function updateFullName(value: string) {
    setNameText(value);
    setDraft((current) => ({ ...current, ...splitFullName(value) }));
  }
  async function submit(e: FormEvent) {
    e.preventDefault();
    if (busy) return;
    setError("");
    const invalid = (
      [
        ["name", nameText],
        ["birth", birthText],
        ["death", deathText],
      ] as const
    )
      .map(([key, value]) => (validateField(key, value) ? key : null))
      .filter(Boolean);
    if (invalid.length) {
      const input = formRef.current?.querySelector<HTMLInputElement>(
        `[data-field="${invalid[0]}"]`,
      );
      let parent = input?.parentElement;
      while (parent) {
        if (parent instanceof HTMLDetailsElement) parent.open = true;
        parent = parent.parentElement;
      }
      input?.focus();
      return;
    }
    const unnamedRepository = formRef.current?.querySelector<HTMLInputElement>(
      '.source-repository-editor input[aria-invalid="true"]',
    );
    if (unnamedRepository) {
      let parent = unnamedRepository.parentElement;
      while (parent) {
        if (parent instanceof HTMLDetailsElement) parent.open = true;
        parent = parent.parentElement;
      }
      setError("Укажите название хранилища перед сохранением.");
      unnamedRepository.focus();
      return;
    }
    try {
      if (!draft.name.trim() || !draft.surname.trim())
        throw new Error("Укажите фамилию и имя. Отчество можно пропустить.");
      if (draft.factAlternatives?.some((alternative) =>
        !alternative.value.trim() || !alternative.sources.length))
        throw new Error("У каждого альтернативного варианта должны быть значение и источник.");
      if (draft.events?.some((event) => event.alternatives?.some((alternative) =>
        !alternative.value.trim() || !alternative.sources.length)))
        throw new Error("У каждого альтернативного варианта события должны быть значение и источник.");
      const birth = normalizeDateInput(birthText),
        death = normalizeDateInput(deathText) || undefined;
      const current = family;
      let portrait = draft.photo;
      if (portraitFile) {
        portrait = await uploadPortrait(portraitFile);
        field("photo", portrait);
        setPortraitFile(null);
        setPortraitPreview("");
      }
      let p: Person = {
        ...draft,
        birth,
        death,
        factAlternatives: draft.factAlternatives?.map((alternative) => ({
          ...alternative,
          value: alternative.field === "birth" || alternative.field === "death"
            ? normalizeDateInput(alternative.value)
            : alternative.value.trim(),
        })),
        events: draft.events?.map((event) => ({
          ...event,
          alternatives: event.alternatives?.map((alternative) => ({
            ...alternative,
            value: alternative.field === "date"
              ? normalizeDateInput(alternative.value) : alternative.value.trim(),
          })),
          date: event.date ? normalizeDateInput(event.date) : undefined,
          endDate: event.endDate
            ? normalizeDateInput(event.endDate)
            : undefined,
        })),
        sex: autoSex ? suggestedSex : draft.sex,
        photo: portrait,
        name: draft.name.trim(),
        surname: draft.surname.trim(),
        patronymic: draft.patronymic.trim(),
        column:
          person && person.birth === birth
            ? draft.column
            : availableColumn(
                current.people.filter((x) => x.id !== draft.id),
                birth,
              ),
      };
      p = rebasePersonDraft(
        person,
        current.people.find((item) => item.id === draft.id),
        p,
      );
      let next = applyPersonDraft(current, p, removedConnections);
      if (!person && relativeTo) {
        next =
          relationship === "child"
            ? connectPeople(next, relativeTo.id, p.id, "parent")
            : connectPeople(
                next,
                p.id,
                relativeTo.id,
                relationship,
                "",
                twinKind,
              );
      }
      for (const hint of confirmed)
        next = connectPeople(next, hint.from, hint.to, "parent");
      await save(next);
      onDirtyChange?.(false);
      onSaved(p.id);
      onClose();
    } catch (e) {
      setError((e as Error).message);
    }
  }
  const connections: Connection[] = [
    ...family.people.flatMap((p) =>
      p.parents.map((id) => ({ from: id, to: p.id, type: "parent" as const })),
    ),
    ...family.people
      .flatMap((p) =>
        p.spouses.map((id) => ({
          from: p.id,
          to: id,
          type: "spouse" as const,
        })),
      )
      .filter(
        (e, i, a) =>
          a.findIndex(
            (x) =>
              [x.from, x.to].sort().join() === [e.from, e.to].sort().join(),
          ) === i,
      ),
    ...(family.links || []),
  ].filter((e) => e.from === draft.id || e.to === draft.id);
  function dateEvidenceStatus(kind: "birth" | "death") {
    const dateClaim = kind === "birth" ? draft.birthDateClaim : draft.deathDateClaim;
    const placeClaim = kind === "birth" ? draft.birthPlaceClaim : draft.deathPlaceClaim;
    const date = hintDate(kind === "birth" ? birthText : deathText);
    const place = kind === "birth" ? draft.birthPlace : draft.deathPlace || "";
    if ((dateClaim && dateClaim.value !== date) ||
        (placeClaim && placeClaim.value !== place)) return " · требуется решение";
    if (dateClaim || placeClaim || draft.factAlternatives?.some((item) =>
      item.field === kind || item.field === `${kind}Place`)) return " · есть записи";
    return "";
  }
  return (
    <EditorDialog
      className="person-editor-shell"
      inline={inline}
      suspended={suspended}
      title={person ? "Редактировать человека" : "Новый человек"}
      onClose={close}
    >
      <form
        ref={formRef}
        noValidate
        onSubmit={submit}
        className="archive-form person-editor-form"
      >
        {!person && (
          <p className="flow-intro">
            Достаточно фамилии и имени. Остальные сведения можно добавить позже.
          </p>
        )}
        <div
          className={
            person
              ? "person-editor-primary is-existing"
              : "person-editor-primary"
          }
        >
          {person && (
            <div className="person-editor-portrait-awards">
              <div className="portrait-picker">
                <button
                  type="button"
                  className="portrait-preview portrait-edit-button"
                  onClick={() => setGalleryOpen(true)}
                  disabled={busy}
                  aria-label="Выбрать портрет из фотографий человека"
                  aria-haspopup="dialog"
                  title="Изменить портрет"
                >
                  {portraitPreview || draft.photo ? (
                    <img
                      src={portraitPreview || mediaPreview(draft.photo)}
                      alt=""
                    />
                  ) : (
                    <UserRound size={34} strokeWidth={1.2} aria-hidden="true" />
                  )}
                  <span className="portrait-edit-overlay" aria-hidden="true">
                    <Pencil size={22} strokeWidth={1.6} />
                  </span>
                </button>
              </div>
              <AwardsEditor
                awards={draft.awards || []}
                onChange={(awards) => field("awards", awards)}
              />
            </div>
          )}
          {relativeTo && !person && (
            <>
              <label>
                Кем новый человек приходится {fullName(relativeTo)}
                <select
                  value={relationship}
                  onChange={(e) =>
                    setRelationship(e.target.value as "child" | ConnectionType)
                  }
                >
                  <option value="child">Ребёнок</option>
                  {owns(user, relativeTo) && (
                    <>
                      <option value="parent">Родитель</option>
                      <option value="spouse">Супруг / супруга</option>
                      <option value="godparent">Крёстный / крёстная</option>
                      <optgroup label="Другие связи">
                        {Object.entries(CONNECTION_NAMES)
                          .filter(
                            ([type]) =>
                              !["parent", "spouse", "godparent"].includes(type),
                          )
                          .map(([type, label]) => (
                            <option key={type} value={type}>
                              {label}
                            </option>
                          ))}
                      </optgroup>
                    </>
                  )}
                </select>
              </label>
              {relationship === "twin" && (
                <label>
                  Тип близнецов
                  <select
                    value={twinKind}
                    onChange={(e) => setTwinKind(e.target.value as TwinKind)}
                  >
                    <option value="unknown">Неизвестен</option>
                    <option value="identical">Однояйцевые</option>
                    <option value="fraternal">Разнояйцевые</option>
                  </select>
                </label>
              )}
            </>
          )}
          <div className="person-editor-basics">
            <label className="name-entry">
              ФИО
              <input
                required
                data-field="name"
                aria-invalid={!!fieldErrors.name}
                autoComplete="off"
                value={nameText}
                placeholder="Иванов Иван Иванович"
                aria-describedby={`${fieldId}-name-hint ${fieldId}-name-error`}
                onBlur={() => validateField("name", nameText)}
                onChange={(e) => updateFullName(e.target.value)}
              />
              <small id={`${fieldId}-name-hint`}>
                Фамилия, имя, отчество. Отчество необязательно.
              </small>
              <small
                id={`${fieldId}-name-error`}
                className="field-error"
                role="alert"
              >
                {fieldErrors.name}
              </small>
            </label>
            {possibleReversedName && (
              <div className="name-order-hint" role="note">
                <span>
                  Возможно, имя и фамилия переставлены. Сейчас фамилия —
                  «{nameParts[0]}», имя — «{nameParts[1]}».
                </span>
                <button type="button" onClick={() =>
                  updateFullName(`${nameParts[1]} ${nameParts[0]}`)}>
                  Поменять местами
                </button>
              </div>
            )}
            <label className="name-sex-hint">
              Пол
              <select
                value={autoSex ? "auto" : draft.sex}
                onChange={(e) => {
                  setAutoSex(e.target.value === "auto");
                  if (e.target.value !== "auto") field("sex", e.target.value);
                }}
              >
                <option value="auto">
                  {suggestedSex === "m"
                    ? `Мужской · ${relationshipSex !== "u" ? "по супругу" : "по ФИО"}`
                    : suggestedSex === "f"
                      ? `Женский · ${relationshipSex !== "u" ? "по супругу" : "по ФИО"}`
                      : "Определить по ФИО"}
                </option>
                <option value="m">Мужской</option>
                <option value="f">Женский</option>
              </select>
            </label>
          </div>
          <div className="person-editor-facts">
            <label>
              Фамилия при рождении
              <input value={draft.maidenName || ""}
                onChange={(e) => field("maidenName", e.target.value)} />
            </label>
            <label>
              Занятие
              <input value={draft.occupation || ""}
                onChange={(e) => field("occupation", e.target.value)} />
            </label>
          </div>
        </div>
        <label className="check-field person-review-status">
          <input
            type="checkbox"
            checked={!!draft.needsReview}
            onChange={(event) => field("needsReview", event.target.checked)}
          />
          Требует проверки
        </label>
        <details className="form-details person-extra" open>
          <summary>
            <CalendarDays size={17} aria-hidden="true" />
            Рождение и смерть
          </summary>
          {(["birth", "death"] as const).map((kind) => (
            <section className="person-date-group" key={kind}>
              <h3>{kind === "birth" ? "Рождение" : "Смерть"}</h3>
              <div className="form-grid">
                <label>
                  Дата
                  <input
                    data-field={kind}
                    aria-invalid={!!fieldErrors[kind]}
                    aria-describedby={`${fieldId}-${kind}-error`}
                    value={kind === "birth" ? birthText : deathText}
                    placeholder="1.5.1980, 05.1980 или 1980"
                    onChange={(e) =>
                      (kind === "birth" ? setBirthText : setDeathText)(
                        e.target.value,
                      )
                    }
                    onBlur={() => {
                      validateField(
                        kind,
                        kind === "birth" ? birthText : deathText,
                      );
                      try {
                        (kind === "birth" ? setBirthText : setDeathText)(
                          dateInputLabel(
                            normalizeDateInput(
                              kind === "birth" ? birthText : deathText,
                            ),
                          ),
                        );
                      } catch {
                        /* Проверяется при сохранении. */
                      }
                    }}
                  />
                  <small
                    id={`${fieldId}-${kind}-error`}
                    className="field-error"
                    role="alert"
                  >
                    {fieldErrors[kind]}
                  </small>
                </label>
                <PlaceField
                  label="Место"
                  value={
                    draft[kind === "birth" ? "birthPlace" : "deathPlace"] || ""
                  }
                  onChange={(value) =>
                    field(kind === "birth" ? "birthPlace" : "deathPlace", value)
                  }
                  onLocation={(location) =>
                    setDraft((current) => ({
                      ...current,
                      [kind === "birth" ? "birthLocation" : "deathLocation"]:
                        location,
                    }))
                  }
                />
              </div>
              {(draft[kind === "birth" ? "birthDateClaim" : "deathDateClaim"] ||
                draft[kind === "birth" ? "birthPlaceClaim" : "deathPlaceClaim"] ||
                draft.factAlternatives?.some((item) => item.field === kind || item.field === `${kind}Place`)) &&
              <details className="form-details person-evidence-details">
                <summary>
                  Точные источники и варианты {kind === "birth" ? "рождения" : "смерти"}
                  {dateEvidenceStatus(kind)}
                </summary>
                <ValueClaimSourcesEditor
                  kind={kind}
                  subject="date"
                  value={hintDate(kind === "birth" ? birthText : deathText)}
                  claim={kind === "birth" ? draft.birthDateClaim : draft.deathDateClaim}
                  onChange={(claim) => field(kind === "birth" ? "birthDateClaim" : "deathDateClaim", claim)}
                  isAdmin={isAdmin}
                  canAssess={canAssessArchiveEvidence(user)}
                />
                <ValueClaimSourcesEditor
                  kind={kind}
                  subject="place"
                  value={kind === "birth" ? draft.birthPlace : draft.deathPlace || ""}
                  claim={kind === "birth" ? draft.birthPlaceClaim : draft.deathPlaceClaim}
                  onChange={(claim) => field(kind === "birth" ? "birthPlaceClaim" : "deathPlaceClaim", claim)}
                  isAdmin={isAdmin}
                  canAssess={canAssessArchiveEvidence(user)}
                />
                <PersonAlternativeClaims kind={kind}
                  alternatives={draft.factAlternatives || []}
                  savedIds={new Set(person?.factAlternatives?.map((item) => item.id) || [])}
                  onChange={(alternatives) => field("factAlternatives", alternatives)}
                  isAdmin={isAdmin}
                  canAssess={canAssessArchiveEvidence(user)}
                />
              </details>}
              {kind === "death" &&
                !deathText.trim() &&
                !draft.deathPlace?.trim() && (
                  <div
                    className={`person-deceased-status${deceasedHint ? " is-suggested" : ""}`}
                  >
                    {deceasedHint && (
                      <p id={`${fieldId}-deceased-hint`}>
                        По данным архива средняя продолжительность жизни —{" "}
                        {deceasedHint.averageYears.toLocaleString("ru-RU")} лет
                        (выборка — {deceasedHint.sampleSize} человек).
                        Минимальный возможный возраст —{" "}
                        {deceasedHint.ageAtLeast}{" "}
                        {plural(deceasedHint.ageAtLeast, "год", "года", "лет")}.
                        Если известно, что он умер, отметьте это; дата смерти
                        может остаться неизвестной.
                      </p>
                    )}
                    <label className="check-field">
                      <input
                        type="checkbox"
                        checked={!!draft.deceased}
                        aria-describedby={
                          deceasedHint ? `${fieldId}-deceased-hint` : undefined
                        }
                        onChange={(event) =>
                          field("deceased", event.target.checked)
                        }
                      />
                      Известно, что человек умер; дата смерти неизвестна
                    </label>
                  </div>
                )}
            </section>
          ))}
        </details>
        {suggestions.length > 0 && (
          <details className="name-suggestions" open>
            <summary>
              Возможно, уже есть родственники · {suggestions.length}
            </summary>
            <p>Отметьте верные связи — добавим их при сохранении.</p>
            <div className="name-suggestions-list">
              {suggestions.map((hint) => {
                const key = `${hint.from}:${hint.to}`;
                return (
                  <label
                    className="check-field"
                    key={key}
                    htmlFor={`hint-${key}`}
                    aria-label={`Подтвердить связь с ${fullName(hint.person)}`}
                  >
                    <input
                      id={`hint-${key}`}
                      type="checkbox"
                      checked={accepted.includes(key)}
                      onChange={(e) => {
                        setAccepted((values) =>
                          e.target.checked
                            ? [
                                ...values.filter(
                                  (value) =>
                                    !suggestions.some(
                                      (other) =>
                                        `${other.from}:${other.to}` === value &&
                                        other.to === hint.to &&
                                        other.parentSex === hint.parentSex,
                                    ),
                                ),
                                key,
                              ]
                            : values.filter((value) => value !== key),
                        );
                      }}
                    />
                    <span>
                      <b>
                        {hint.role === "father"
                          ? "Возможный отец"
                          : hint.role === "mother"
                            ? "Возможная мать"
                            : hint.role === "parent"
                              ? "Возможный родитель"
                              : "Возможный ребёнок"}
                        : {fullName(hint.person)}
                      </b>
                      <small>{hint.reason}</small>
                    </span>
                  </label>
                );
              })}
            </div>
          </details>
        )}
        <SiblingSuggestions hints={siblings} />
        {surnames.map(({ surname, parent }) => (
          <div className="surname-suggestion" key={surname}>
            <p>
              Возможно, фамилия при рождении — <b>{surname}</b>. По фамилии
              отца: {fullName(parent)}.
            </p>
            <button type="button" onClick={() => field("maidenName", surname)}>
              Да, указать {surname}
            </button>
          </div>
        ))}
        {draft.maidenName && (
          <p className="birth-surname-value">
            Фамилия при рождении: <b>{draft.maidenName}</b>{" "}
            <button type="button" onClick={() => field("maidenName", "")}>
              Убрать
            </button>
          </p>
        )}
        <details className="form-details">
          <summary>
            <ContactRound size={17} aria-hidden="true" />
            ФИО и фамилия при рождении
          </summary>
          <div className="form-grid">
            {(
              [
                ["surname", "Фамилия"],
                ["name", "Имя"],
                ["patronymic", "Отчество"],
              ] as const
            ).map(([key, label]) => (
              <label key={key}>
                {label}
                <input
                  value={draft[key] || ""}
                  onChange={(e) => field(key, e.target.value)}
                />
              </label>
            ))}
          </div>
          <ValueClaimSourcesEditor
            kind="birth"
            subject="surname"
            value={draft.maidenName || ""}
            claim={draft.maidenNameClaim}
            onChange={(claim) => field("maidenNameClaim", claim)}
            onPreservePrevious={() => setDraft((current) =>
              preserveBirthSurnameClaim(current, crypto.randomUUID()))}
            isAdmin={isAdmin}
            canAssess={canAssessArchiveEvidence(user)}
          />
          <PersonAlternativeClaims kind="maidenName"
            alternatives={draft.factAlternatives || []}
            savedIds={new Set(person?.factAlternatives?.map((item) => item.id) || [])}
            onChange={(alternatives) => field("factAlternatives", alternatives)}
            isAdmin={isAdmin}
            canAssess={canAssessArchiveEvidence(user)} />
        </details>
        <details className="form-details">
          <summary>
            <BookOpen size={17} aria-hidden="true" />
            Жизнь и занятия
          </summary>
          <ValueClaimSourcesEditor
            kind="occupation"
            subject="occupation"
            value={draft.occupation || ""}
            claim={draft.occupationClaim}
            onChange={(claim) => field("occupationClaim", claim)}
            onPreservePrevious={() => setDraft((current) =>
              preserveOccupationClaim(current, crypto.randomUUID()))}
            isAdmin={isAdmin}
            canAssess={canAssessArchiveEvidence(user)}
          />
          <PersonAlternativeClaims kind="occupation"
            alternatives={draft.factAlternatives || []}
            savedIds={new Set(person?.factAlternatives?.map((item) => item.id) || [])}
            onChange={(alternatives) => field("factAlternatives", alternatives)}
            isAdmin={isAdmin}
            canAssess={canAssessArchiveEvidence(user)} />
          <label>
            История человека
            <textarea
              rows={4}
              value={draft.biography || ""}
              onChange={(e) => field("biography", e.target.value)}
            />
          </label>
        </details>
        <EventsEditor
          events={draft.events || []}
          savedEvents={person?.events}
          onChange={(events) => field("events", events)}
          personId={person?.id}
          isAdmin={isAdmin}
          canAssess={canAssessArchiveEvidence(user)}
        />
        <details className="form-details">
          <summary>
            <Files size={17} aria-hidden="true" />
            Источники
          </summary>
          <section>
            <h3>Источники</h3>
            {draft.sources.map((s, i) => (
              <div className="source-editor" key={i}>
                {s.catalogId ? <div className="source-catalog-citation">
                  <small>Источник из каталога{s.type ? ` · ${s.type}` : ""}</small>
                  <strong>{s.title}</strong>
                  {s.reference && <span>{s.reference}</span>}
                  {s.note && <span>{s.note}</span>}
                  {safeUrl(s.url) && <a href={archiveResourceUrl(safeUrl(s.url) || "")}
                    target="_blank" rel="noopener noreferrer">Открыть источник</a>}
                  {s.documentId && <a
                    href={scopedArchivePath(archiveDocumentPath(null, s.documentId, s.documentPage))}
                    target="_blank" rel="noopener noreferrer">Открыть документ{s.documentPage
                      ? ` · стр. ${s.documentPage}` : ""}</a>}
                </div> : <>
                <SourceRepositoryEditor source={s} onChange={(next) =>
                  field("sources", draft.sources.map((source, index) =>
                    index === i ? next : source))} />
                {(
                  [
                    ["title", "Название"],
                    ["type", "Тип документа"],
                    ["reference", "Архивный шифр"],
                    ["url", "Ссылка"],
                    ["note", "Примечание"],
                  ] as const
                ).map(([key, label]) => (
                  <label key={key}>
                    {label}
                    <input
                      value={s[key] || ""}
                      onChange={(e) =>
                        field(
                          "sources",
                          draft.sources.map((x, j) =>
                            i === j ? { ...x, [key]: e.target.value } : x,
                          ),
                        )
                      }
                    />
                  </label>
                ))}
                <DocumentSourcePicker
                  personId={person?.id}
                  documentId={s.documentId}
                  pageNumber={s.documentPage}
                  onChange={(document) =>
                    field(
                      "sources",
                      draft.sources.map((source, index) =>
                        i === index
                          ? {
                              ...source,
                              title: source.title || document?.title || "",
                              documentId: document?.id,
                              documentPage:
                                document?.id === source.documentId
                                  ? source.documentPage
                                  : undefined,
                            }
                          : source,
                      ),
                    )
                  }
                  onPageChange={(documentPage) =>
                    field(
                      "sources",
                      draft.sources.map((source, index) =>
                        i === index ? { ...source, documentPage } : source,
                      ),
                    )
                  }
                />
                </>}
                <button
                  type="button"
                  className="icon-button source-remove"
                  aria-label={`Убрать источник ${i + 1}`}
                  title="Убрать источник"
                  onClick={() =>
                    field(
                      "sources",
                      draft.sources.filter((_, j) => i !== j),
                    )
                  }
                >
                  <Trash2 size={16} />
                </button>
              </div>
            ))}
            <button
              type="button"
              disabled={draft.sources.length >= 50}
              onClick={() =>
                field("sources", [
                  ...draft.sources,
                  { title: "", type: "", reference: "" },
                ])
              }
            >
              + Источник
            </button>
            {isAdmin && draft.sources.length < 50 && <CatalogPicker
              existing={draft.sources}
              onChoose={(entry) => field("sources", [...draft.sources, sourceCitation(entry)])}
            />}
          </section>
          <PersonDocumentsEditor personId={person?.id} disabled={busy} />
        </details>
        <details className="form-details">
          <summary>
            <UsersRound size={17} aria-hidden="true" />
            Семейные связи
          </summary>
          {draft.parents.length > 0 && (
            <>
              <p>
                {draft.parents
                  .map((id) => family.people.find((p) => p.id === id))
                  .filter((p) => !!p)
                  .map((p) => fullName(p))
                  .join(" · ")}
              </p>
              <label className="check-field">
                <input
                  type="checkbox"
                  checked={draft.parentageComplete ?? draft.parents.length >= 2}
                  onChange={(e) => field("parentageComplete", e.target.checked)}
                />
                Все кровные родители известны и указаны
              </label>
              <p className="field-hint">
                Если второй родитель неизвестен, оставьте отметку выключенной.
                Она помогает различать родных и неполнородных братьев и сестёр.
              </p>
            </>
          )}
          {person && (
            <section>
              <h3>Прямые связи</h3>
              {connections.map((edge, i) => {
                const removed = removedConnections.some(
                  (item) =>
                    item.from === edge.from &&
                    item.to === edge.to &&
                    item.type === edge.type,
                );
                return (
                  <div
                    className={`connection-row${removed ? " is-removed" : ""}`}
                    key={i}
                  >
                    <span>
                      {fullName(family.people.find((p) => p.id === edge.from)!)}{" "}
                      → {CONNECTION_NAMES[edge.type]} →{" "}
                      {fullName(family.people.find((p) => p.id === edge.to)!)}
                    </span>
                    <button
                      type="button"
                      className="icon-button"
                      title={
                        removed
                          ? "Восстановить связь"
                          : "Убрать связь при сохранении"
                      }
                      aria-label={`${removed ? "Восстановить" : "Убрать"} связь: ${fullName(family.people.find((p) => p.id === edge.from)!)} — ${fullName(family.people.find((p) => p.id === edge.to)!)}`}
                      disabled={busy}
                      onClick={() =>
                        setRemovedConnections((items) =>
                          removed
                            ? items.filter(
                                (item) =>
                                  !(
                                    item.from === edge.from &&
                                    item.to === edge.to &&
                                    item.type === edge.type
                                  ),
                              )
                            : [...items, edge],
                        )
                      }
                    >
                      {removed ? <Undo2 size={16} /> : <Trash2 size={16} />}
                    </button>
                  </div>
                );
              })}
            </section>
          )}
        </details>
        {error && (
          <p role="alert" className="form-error">
            {error}
          </p>
        )}
        {person && isAdmin && (
          <details className="form-details person-delete-section">
            <summary>
              <Trash2 size={16} aria-hidden="true" />
              Удаление карточки
            </summary>
            <p>
              Карточка, связи и отметки этого человека будут удалены. Сами
              фотографии останутся.
            </p>
            <button
              type="button"
              className="danger-action"
              disabled={busy}
              onClick={async () => {
                if (!confirm) {
                  setConfirm(true);
                  return;
                }
                try {
                  await save(removePerson(family, person.id));
                  onDirtyChange?.(false);
                  onClose();
                } catch (e) {
                  setError((e as Error).message);
                }
              }}
            >
              {confirm ? "Подтвердить удаление человека" : "Удалить человека"}
            </button>
          </details>
        )}
        <footer>
          {dirty && (
            <span className="person-editor-save-state" role="status">
              Есть несохранённые изменения
            </span>
          )}
          <button type="submit" className="primary-action" disabled={busy}>
            {busy ? "Сохраняем…" : "Сохранить"}
          </button>
          <button
            type="button"
            className="text-action"
            disabled={busy}
            onClick={close}
          >
            Закрыть
          </button>
        </footer>
      </form>
      {galleryOpen && (
        <EditorDialog
          title="Выбрать портрет"
          onClose={() => setGalleryOpen(false)}
          wide
        >
          <div className="portrait-gallery">
            {portraitPhotos.map((photo) => (
              <button
                type="button"
                key={photo.id}
                onClick={() => {
                  setGalleryOpen(false);
                  setCropSource(photo.url);
                }}
              >
                <img
                  src={mediaPreview(photo.url)}
                  alt={photoLabel(photo)}
                  loading="lazy"
                />
                <span>{photoLabel(photo)}</span>
              </button>
            ))}
            {!portraitPhotos.length && (
              <p className="portrait-gallery-empty">
                {person
                  ? "Пока нет снимков с отметкой этого человека. Отметьте его на фото в галерее."
                  : "Сначала сохраните человека и отметьте его на фото."}
              </p>
            )}
          </div>
          {(draft.photo || portraitFile) && (
            <div className="portrait-gallery-actions">
              <button
                type="button"
                disabled={busy}
                onClick={() => {
                  field("photo", "");
                  setPortraitFile(null);
                  setPortraitPreview("");
                  setGalleryOpen(false);
                }}
              >
                Убрать портрет
              </button>
            </div>
          )}
        </EditorDialog>
      )}
      {cropSource && (
        <PortraitCropper
          key={cropSource}
          src={cropSource}
          onClose={() => setCropSource("")}
          onCrop={(file) => {
            setPortraitFile(file);
            setPortraitPreview(URL.createObjectURL(file));
            setCropSource("");
          }}
        />
      )}
    </EditorDialog>
  );
}
