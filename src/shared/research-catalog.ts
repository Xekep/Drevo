import type { ResearchSearchSettings } from "./web-search.ts";

export type ResearchResourceSummary = {
  id: string;
  categoryId: string;
  name: string;
  url: string;
  description: string;
};

export type ResearchResource = ResearchResourceSummary & ResearchSearchSettings;
export type ResearchCategory = {
  id: string;
  name: string;
  resources: ResearchResource[];
};
export type ResearchDirectoryCategory = Omit<ResearchCategory, "resources"> & {
  resources: ResearchResourceSummary[];
};
