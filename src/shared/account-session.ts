import type { ArchiveUser } from "../domain/access.ts";

export type AccountSession = {
  user: ArchiveUser | null;
  /** A view-as response describes the selected participant, not a login switch. */
  preview?: boolean;
  participantPreview?: { id: string; name: string };
  account?: {
    id: string;
    name: string;
    createdAt: string;
    fullAccess: boolean;
    globalRole?: "admin" | "researcher" | null;
    provider: "vk" | "yandex" | "email" | null;
    providers?: ("vk" | "yandex" | "email")[];
  } | null;
  local: boolean;
  yandex: boolean;
  vk?: boolean;
  email?: boolean;
};
