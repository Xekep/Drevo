export type PublicationStatus = "unknown" | "loading" | "published" | "hidden" | "error";

/** One canvas owns its status cache; visible cards share bounded read requests. */
export class TreePublicationStatuses {
  private states = new Map<string, { status: PublicationStatus; checkedAt: number; version: number }>();
  private listeners = new Map<string, Set<() => void>>();
  private pending = new Set<string>();
  private controller: AbortController | null = null;
  private active = false;
  private scheduled = false;
  private version = 0;
  private endpoint: string;
  private request: typeof fetch;

  constructor(endpoint: string, request: typeof fetch) {
    this.endpoint = endpoint;
    this.request = request;
  }

  start() {
    this.active = true;
    for (const id of this.listeners.keys()) this.refresh(id);
    this.schedule();
  }

  stop() {
    this.active = false;
    this.controller?.abort();
    this.controller = null;
    this.pending.clear();
    for (const [id, state] of this.states) {
      if (state.status === "loading") this.set(id, "unknown", 0);
    }
  }

  get(id: string): PublicationStatus {
    return this.states.get(id)?.status || "unknown";
  }

  subscribe(id: string, listener: () => void) {
    const listeners = this.listeners.get(id) || new Set<() => void>();
    this.listeners.set(id, listeners);
    listeners.add(listener);
    this.refresh(id);
    return () => {
      listeners.delete(listener);
      if (!listeners.size) {
        this.listeners.delete(id);
        this.pending.delete(id);
      }
    };
  }

  refresh(id: string) {
    const state = this.states.get(id);
    if (state?.status === "loading" ||
        (state && Date.now() - state.checkedAt < 30_000)) return;
    this.pending.add(id);
    this.schedule();
  }

  update(id: string, published: boolean) {
    this.pending.delete(id);
    this.set(id, published ? "published" : "hidden", Date.now());
  }

  private set(id: string, status: PublicationStatus, checkedAt: number) {
    this.states.set(id, { status, checkedAt, version: ++this.version });
    this.listeners.get(id)?.forEach((listener) => listener());
  }

  private schedule() {
    if (!this.active || this.scheduled || this.controller || !this.pending.size) return;
    this.scheduled = true;
    queueMicrotask(() => {
      this.scheduled = false;
      if (this.active && !this.controller) void this.load();
    });
  }

  private async load() {
    const ids = [...this.pending].filter((id) => this.listeners.has(id)).slice(0, 50);
    if (!ids.length) return;
    const params = new URLSearchParams();
    const versions = new Map<string, number>();
    for (const id of ids) {
      this.pending.delete(id);
      params.append("id", id);
      this.set(id, "loading", 0);
      versions.set(id, this.states.get(id)!.version);
    }
    const controller = new AbortController();
    this.controller = controller;
    try {
      const response = await this.request(`${this.endpoint}?${params}`, {
        signal: controller.signal, cache: "no-store",
      });
      const body = await response.json();
      if (!response.ok || !body.fields || typeof body.fields !== "object" || Array.isArray(body.fields))
        throw new Error("Не удалось проверить доступность для поиска");
      if (controller.signal.aborted) return;
      for (const id of ids) {
        // A dialog's successful write wins over an older in-flight read.
        if (this.states.get(id)?.version === versions.get(id))
          this.set(id, Object.hasOwn(body.fields, id) ? "published" : "hidden", Date.now());
      }
    } catch {
      if (!controller.signal.aborted) {
        for (const id of ids) {
          if (this.states.get(id)?.version === versions.get(id))
            this.set(id, "error", Date.now());
        }
      }
    } finally {
      if (this.controller === controller) this.controller = null;
      this.schedule();
    }
  }
}
