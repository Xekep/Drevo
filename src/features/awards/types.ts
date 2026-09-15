export type AwardKind = "order" | "medal" | "title" | "badge" | "cross";

export type AwardImage = {
  src: string;
  sourcePage: string;
  license: string;
  author?: string;
};

export type AwardDegree = {
  id: string;
  label: string;
  aliases?: string[];
  image?: AwardImage;
};

export type AwardDefinition = {
  id: string;
  /** Stable country/system code, not necessarily current ISO. */
  country: string;
  countryName: string;
  kind: AwardKind;
  /** State, departmental, regional or organisation-level award. */
  level: "state" | "departmental" | "regional" | "organisation";
  name: string;
  description: string;
  /** Historic abbreviations, translations and common wording used by the matcher. */
  aliases?: string[];
  establishedAt?: string;
  discontinuedAt?: string;
  issuer?: string;
  degrees?: AwardDegree[];
  tags: string[];
  image?: AwardImage;
  imageStatus: "verified" | "pending-license-review";
};
