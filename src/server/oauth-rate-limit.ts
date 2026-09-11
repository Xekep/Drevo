const DEFAULT_WINDOW = 10 * 60 * 1000;
const DEFAULT_LIMIT = 30;
const DEFAULT_CLIENTS = 4096;

export function oauthClientKey(
  realIp: string | string[] | undefined,
  remoteAddress = "",
) {
  const value = typeof realIp === "string" ? realIp.trim() : "";
  if (/^[0-9a-fA-F:.]{3,64}$/.test(value)) return value;
  return remoteAddress.slice(0, 64) || "unknown";
}

export function createOAuthStartLimiter({
  windowMs = DEFAULT_WINDOW,
  limit = DEFAULT_LIMIT,
  maxClients = DEFAULT_CLIENTS,
  now = Date.now,
}: {
  windowMs?: number;
  limit?: number;
  maxClients?: number;
  now?: () => number;
} = {}) {
  const clients = new Map<string, { started: number; count: number }>();

  function cleanup(time: number) {
    for (const [key, entry] of clients)
      if (time - entry.started >= windowMs) clients.delete(key);
  }

  return {
    allow(client: string) {
      const time = now();
      cleanup(time);
      const entry = clients.get(client);
      if (!entry) {
        if (clients.size >= maxClients) return false;
        clients.set(client, { started: time, count: 1 });
        return true;
      }
      if (entry.count >= limit) return false;
      entry.count++;
      return true;
    },
  };
}
