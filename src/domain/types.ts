export type Source = {
  /** Reference to an archive-wide source record; legacy inline citations omit it. */
  catalogId?: string;
  title: string;
  type: string;
  reference: string;
  url?: string;
  note?: string;
  /** One named GEDCOM repository. Legacy citations keep only their text fields. */
  repository?: {
    name: string;
    callNumber: string;
    website: string;
    note: string;
    linkNote: string;
  };
  /** PDF already present in this archive's document catalogue. */
  documentId?: string;
  /** One-based page of the linked PDF. */
  documentPage?: number;
};
export type PersonAward = {
  id: string;
  name: string;
  /** Stable reference into the built-in catalogue; absent for legacy/custom awards. */
  awardDefinitionId?: string;
  /** Degree within a multi-degree award, for example I/II/III. */
  degreeId?: string;
  year?: string;
  source?: { title: string; url?: string };
};
export type PersonEvent = {
  id: string;
  /** Стандартный тег исходного события для повторного экспорта GEDCOM. */
  gedcomTag?: string;
  type:
    | "residence"
    | "move"
    | "education"
    | "work"
    | "military"
    | "marriage"
    | "divorce"
    | "baptism"
    | "burial"
    | "other";
  title?: string;
  date?: string;
  endDate?: string;
  /** Исходная приблизительная дата; не превращается в точный год. */
  dateText?: string;
  /** Citations for one normalized event date, not a range or approximate phrase. */
  dateClaim?: PersonValueClaim;
  place?: string;
  /** Citations for this exact event-place wording, separate from event-wide evidence. */
  placeClaim?: PersonValueClaim;
  /** Cited competing values; neither changes the displayed date or place. */
  alternatives?: EventFactAlternative[];
  location?: PlaceLocation;
  description?: string;
  sources?: Source[];
};
export type ClaimConfidence = "confirmed" | "probable" | "tentative" | "conflicting" | "unknown";
/** Citations and an explicit researcher's assessment of one recorded value. */
export type PersonValueClaim = { value: string; sources: Source[]; confidence?: ClaimConfidence };
export type EventFactAlternative = PersonValueClaim & {
  id: string;
  field: "date" | "place";
};
/** A cited competing record; it never silently replaces the displayed value. */
export type PersonFactAlternative = PersonValueClaim & {
  id: string;
  field: "birth" | "death" | "birthPlace" | "deathPlace" | "maidenName";
};
/** Evidence for one existing direct parent edge; parents remains authoritative. */
export type ParentClaim = {
  parentId: string;
  sources?: Source[];
  confidence?: ClaimConfidence;
};
export type Person = {
  createdBy?: string;
  id: string;
  surname: string;
  name: string;
  patronymic: string;
  sex: "m" | "f" | "u";
  /** Пустая строка означает неизвестную дату, без подстановки текущего года. */
  birth: string;
  /** Citations for this exact birth-date value, separate from general person sources. */
  birthDateClaim?: PersonValueClaim;
  death?: string;
  /** Citations for this exact death-date value, separate from general person sources. */
  deathDateClaim?: PersonValueClaim;
  deceased?: boolean;
  /** Manual research marker; absence does not mean the card is verified. */
  needsReview?: boolean;
  birthPlace: string;
  /** Citations for this historical place name; map coordinates are separate. */
  birthPlaceClaim?: PersonValueClaim;
  deathPlace?: string;
  deathPlaceClaim?: PersonValueClaim;
  /** Source-backed alternatives to displayed life facts and birth surname. */
  factAlternatives?: PersonFactAlternative[];
  /** Уточнённая точка не заменяет историческое название в birthPlace/deathPlace. */
  birthLocation?: PlaceLocation;
  deathLocation?: PlaceLocation;
  maidenName?: string;
  /** Citations for the current birth surname, separate from other names. */
  maidenNameClaim?: PersonValueClaim;
  occupation?: string;
  /** Citations for the current occupation wording, separate from work events. */
  occupationClaim?: PersonValueClaim;
  biography?: string;
  awards?: PersonAward[];
  events?: PersonEvent[];
  photo?: string;
  parents: string[];
  /** Optional assessment and citations keyed by one ID in parents. */
  parentClaims?: ParentClaim[];
  /** True only when the complete parent list is known. */
  parentageComplete?: boolean;
  spouses: string[];
  generation: number;
  column: number;
  sources: Source[];
};
export type PlaceLocation = {
  place: string;
  lat: number;
  lon: number;
  label?: string;
};
export type Family = {
  title: string;
  description: string;
  demo: boolean;
  people: Person[];
  /** Documented unions; legacy spouse links remain independent when their history is unknown. */
  unions?: FamilyUnion[];
  links?: FamilyLink[];
  photos?: ArchivePhoto[];
};
export type UnionMilestone = {
  /** Calendar date, which may be only a year or a year and month. */
  date?: string;
  /** Original approximate/qualified wording, retained without inventing a precise date. */
  dateText?: string;
  place?: string;
  sources?: Source[];
  /** Explicit research assessment of this stage and its recorded date/place. */
  confidence?: ClaimConfidence;
};
export type FamilyUnion = {
  id: string;
  createdBy?: string;
  participants: [string, string];
  type: "marriage" | "civil_union" | "partnership";
  /** Research assessment of the participants and union type, not its milestones. */
  confidence?: ClaimConfidence;
  formation?: UnionMilestone;
  ending?: UnionMilestone;
  divorce?: UnionMilestone;
  /** Explicit evidence that the union was ongoing at the recorded time. */
  ongoing?: UnionMilestone;
  note?: string;
  sources?: Source[];
};
export type PhotoTag = {
  id: string;
  personId: string;
  x: number;
  y: number;
  width: number;
  height: number;
};
export type ArchivePhoto = {
  createdAt?: string;
  createdBy?: string;
  id: string;
  url: string;
  title: string;
  takenAt?: string;
  place?: string;
  year?: string;
  event?: string;
  description?: string;
  tags: PhotoTag[];
};
export type PhotoMetadata = Pick<
  ArchivePhoto,
  "year" | "place" | "event" | "description"
> & { title?: string };
export const EXTRA_LINK_TYPES = [
  "adoptive_parent",
  "foster_parent",
  "presumed_parent",
  "step_parent",
  "godparent",
  "nurse",
  "sworn_sibling",
  "twin",
  "guardian",
] as const;
export type ExtraLinkType = (typeof EXTRA_LINK_TYPES)[number];
export type TwinKind = "identical" | "fraternal" | "unknown";
export type FamilyLink = {
  createdBy?: string;
  id: string;
  from: string;
  to: string;
  type: ExtraLinkType;
  note?: string;
  /** Свидетельства именно этой дополнительной связи. */
  sources?: Source[];
  /** Ручная оценка участников и типа этой дополнительной связи. */
  confidence?: ClaimConfidence;
  /** Явная запись; совпадение даты рождения не устанавливает близнецов. */
  twinKind?: TwinKind;
};
export type Relation = {
  title: string;
  explanation: string;
  path: string[];
  common: string[];
  kind: "direct" | "blood" | "marriage" | "family" | "unknown";
  distances?: [number, number];
  /** roles[0] describes the first selected person relative to the second. */
  roles?: [KinshipRole, KinshipRole];
  otherRelations?: Relation[];
};
export type KinshipRole = {
  term: string;
  description: string;
  aliases?: string[];
};
