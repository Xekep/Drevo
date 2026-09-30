export type PublicationFields = {
  birthSurname: boolean;
  birthYear: boolean;
  deathYear: boolean;
  birthPlace: boolean;
  deathPlace: boolean;
};

export const defaultPublicationFields: PublicationFields = {
  birthSurname: false,
  birthYear: true,
  deathYear: true,
  birthPlace: true,
  deathPlace: true,
};
