export type Source = {
  title: string;
  type: string;
  reference: string;
  url?: string;
  note?: string;
};
export type PersonAward = {
  id: string;
  name: string;
  year?: string;
  source?: { title: string; url?: string };
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
  death?: string;
  birthPlace: string;
  deathPlace?: string;
  /** Уточнённая точка не заменяет историческое название в birthPlace/deathPlace. */
  birthLocation?: PlaceLocation;
  deathLocation?: PlaceLocation;
  maidenName?: string;
  occupation?: string;
  biography?: string;
  awards?: PersonAward[];
  photo?: string;
  parents: string[];
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
  links?: FamilyLink[];
  photos?: ArchivePhoto[];
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
  "title" | "year" | "place" | "event" | "description"
>;
export const EXTRA_LINK_TYPES = [
  "adoptive_parent",
  "godparent",
  "nurse",
  "sworn_sibling",
  "guardian",
] as const;
export type ExtraLinkType = (typeof EXTRA_LINK_TYPES)[number];
export type FamilyLink = {
  createdBy?: string;
  id: string;
  from: string;
  to: string;
  type: ExtraLinkType;
  note?: string;
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
