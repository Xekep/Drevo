export type PlatformAccount = {
  id: string;
  name: string;
  role: "admin" | "researcher" | null;
  fullAccess: boolean;
  lastVisitAt: string | null;
};
export type PlatformAccountPage = { accounts: PlatformAccount[]; next: string | null };
export type PlatformAccountStatistics = {
  accounts: number; basic: number; full: number; admins: number; researchers: number;
};
