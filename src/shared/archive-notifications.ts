export type ArchiveNotification = {
  id: number;
  at: string;
  kind: "person_added" | "person_comment";
  personId: string;
  personName: string;
  actorName: string;
  read: boolean;
};

export type ArchiveNotificationsPage = {
  items: ArchiveNotification[];
  unread: number;
  next: number | null;
  latest: number;
};
