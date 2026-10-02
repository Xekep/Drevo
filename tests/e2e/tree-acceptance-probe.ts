import type { Page } from "@playwright/test";

type LayoutRequest = {
  people: number;
  requestedAt: number;
  completedAt?: number;
  terminatedAt?: number;
  error?: string;
};

export type AcceptanceSnapshot = {
  requests: LayoutRequest[];
  firstGpuAt: number;
  firstPortraitUploadAt: number;
  portraitUploads: number;
  resources: { textures: number; buffers: number; programs: number };
  frames: { count: number; p95Ms: number; maxMs: number; over50Ms: number };
  longTasks: { startTime: number; duration: number }[];
  now: number;
};

type ProbeState = Omit<AcceptanceSnapshot, "frames" | "now"> & {
  frameGaps: number[];
  lastFrame: number;
  intervalStartedAt: number;
  longTaskObserver?: PerformanceObserver;
};

/** Observe the real renderer from navigation, without changing its eligibility. */
export async function installTreeAcceptanceProbe(page: Page) {
  await page.addInitScript(() => {
    const probeWindow = window as typeof window & {
      __treeAcceptance?: ProbeState;
    };
    if (probeWindow.__treeAcceptance) return;
    const state: ProbeState = {
      requests: [],
      firstGpuAt: 0,
      firstPortraitUploadAt: 0,
      portraitUploads: 0,
      resources: { textures: 0, buffers: 0, programs: 0 },
      frameGaps: [],
      lastFrame: 0,
      intervalStartedAt: 0,
      longTasks: [],
    };
    probeWindow.__treeAcceptance = state;

    const NativeWorker = window.Worker;
    window.Worker = class extends NativeWorker {
      private pending: { id: number | undefined; record: LayoutRequest }[] = [];

      constructor(...args: ConstructorParameters<typeof Worker>) {
        super(...args);
        this.addEventListener("message", (event: MessageEvent) => {
          const data: unknown = event.data;
          if (!data || typeof data !== "object") return;
          if (!("geometry" in data || "positions" in data || "error" in data))
            return;
          const id =
            "requestId" in data && typeof data.requestId === "number"
              ? data.requestId
              : undefined;
          const index = this.pending.findIndex((item) => item.id === id);
          if (index < 0) return;
          const [{ record }] = this.pending.splice(index, 1);
          record.completedAt = performance.now();
          if ("error" in data) record.error = String(data.error);
        });
        this.addEventListener("error", (event: ErrorEvent) => {
          for (const { record } of this.pending) {
            record.completedAt = performance.now();
            record.error = event.message;
          }
          this.pending.length = 0;
        });
      }

      postMessage(
        message: unknown,
        transfer: Transferable[] | StructuredSerializeOptions = [],
      ) {
        let request:
          { id: number | undefined; record: LayoutRequest } | undefined;
        if (
          message &&
          typeof message === "object" &&
          "people" in message &&
          Array.isArray(message.people) &&
          "mode" in message &&
          typeof message.mode === "string"
        ) {
          // Keep neither the family nor the returned geometry. ELK messages do
          // not have this top-level layout-worker protocol.
          request = {
            id:
              "requestId" in message && typeof message.requestId === "number"
                ? message.requestId
                : undefined,
            record: {
              people: message.people.length,
              requestedAt: performance.now(),
            },
          };
          state.requests.push(request.record);
          this.pending.push(request);
        }
        try {
          if (Array.isArray(transfer)) super.postMessage(message, transfer);
          else super.postMessage(message, transfer);
        } catch (error) {
          if (request) {
            request.record.completedAt = performance.now();
            request.record.error = String(error);
            this.pending.splice(this.pending.indexOf(request), 1);
          }
          throw error;
        }
      }

      terminate() {
        const current = this.pending.at(-1);
        if (current) current.record.terminatedAt = performance.now();
        this.pending.length = 0;
        super.terminate();
      }
    };

    if (typeof WebGL2RenderingContext !== "undefined") {
      const prototype = WebGL2RenderingContext.prototype;
      // Weak collections and weak bindings do not keep deleted GPU objects alive.
      const textures = new WeakSet<WebGLTexture>();
      const buffers = new WeakSet<WebGLBuffer>();
      const programs = new WeakSet<WebGLProgram>();
      prototype.createTexture = new Proxy(prototype.createTexture, {
        apply(target, receiver, args) {
          const texture = Reflect.apply(target, receiver, args);
          if (texture) {
            textures.add(texture);
            state.resources.textures++;
          }
          return texture;
        },
      });
      prototype.deleteTexture = new Proxy(prototype.deleteTexture, {
        apply(target, receiver, args) {
          const result = Reflect.apply(target, receiver, args);
          if (args[0] && textures.delete(args[0])) state.resources.textures--;
          return result;
        },
      });
      prototype.createBuffer = new Proxy(prototype.createBuffer, {
        apply(target, receiver, args) {
          const buffer = Reflect.apply(target, receiver, args);
          if (buffer) {
            buffers.add(buffer);
            state.resources.buffers++;
          }
          return buffer;
        },
      });
      prototype.deleteBuffer = new Proxy(prototype.deleteBuffer, {
        apply(target, receiver, args) {
          const result = Reflect.apply(target, receiver, args);
          if (args[0] && buffers.delete(args[0])) state.resources.buffers--;
          return result;
        },
      });
      prototype.createProgram = new Proxy(prototype.createProgram, {
        apply(target, receiver, args) {
          const program = Reflect.apply(target, receiver, args);
          if (program) {
            programs.add(program);
            state.resources.programs++;
          }
          return program;
        },
      });
      prototype.deleteProgram = new Proxy(prototype.deleteProgram, {
        apply(target, receiver, args) {
          const result = Reflect.apply(target, receiver, args);
          if (args[0] && programs.delete(args[0])) state.resources.programs--;
          return result;
        },
      });

      const atlases = new WeakSet<WebGLTexture>();
      const bindings = new WeakMap<
        WebGL2RenderingContext,
        { unit: number; textures: Map<number, WeakRef<WebGLTexture>> }
      >();
      const binding = (gl: WebGL2RenderingContext) => {
        let value = bindings.get(gl);
        if (!value) {
          value = { unit: gl.TEXTURE0, textures: new Map() };
          bindings.set(gl, value);
        }
        return value;
      };
      prototype.activeTexture = new Proxy(prototype.activeTexture, {
        apply(target, receiver, args) {
          const result = Reflect.apply(target, receiver, args);
          binding(receiver).unit = args[0];
          return result;
        },
      });
      prototype.bindTexture = new Proxy(prototype.bindTexture, {
        apply(target, receiver, args) {
          const result = Reflect.apply(target, receiver, args);
          if (args[0] === receiver.TEXTURE_2D) {
            const current = binding(receiver);
            if (args[1])
              current.textures.set(current.unit, new WeakRef(args[1]));
            else current.textures.delete(current.unit);
          }
          return result;
        },
      });
      prototype.texStorage2D = new Proxy(prototype.texStorage2D, {
        apply(target, receiver, args) {
          const result = Reflect.apply(target, receiver, args);
          // GpuPortraitCache owns the two 2048-square, 12-level R8/RGBA8
          // pages. The font atlas is uploaded through texImage2D instead.
          if (
            args[0] === receiver.TEXTURE_2D &&
            args[1] === 12 &&
            (args[2] === receiver.R8 || args[2] === receiver.RGBA8) &&
            args[3] === 2048 &&
            args[4] === 2048
          ) {
            const current = binding(receiver);
            const texture = current.textures.get(current.unit)?.deref();
            if (texture) atlases.add(texture);
          }
          return result;
        },
      });
      prototype.texSubImage2D = new Proxy(prototype.texSubImage2D, {
        apply(target, receiver, args) {
          const result = Reflect.apply(target, receiver, args);
          if (args[0] === receiver.TEXTURE_2D) {
            const current = binding(receiver);
            const texture = current.textures.get(current.unit)?.deref();
            if (texture && textures.has(texture) && atlases.has(texture)) {
              if (!state.firstPortraitUploadAt)
                state.firstPortraitUploadAt = performance.now();
              state.portraitUploads++;
            }
          }
          return result;
        },
      });
    }

    const gpuObserver = new MutationObserver(() => {
      if (document.querySelector('.tree-canvas[data-renderer="webgl2"]')) {
        state.firstGpuAt = performance.now();
        gpuObserver.disconnect();
      }
    });
    gpuObserver.observe(document, {
      subtree: true,
      childList: true,
      attributes: true,
      attributeFilter: ["data-renderer"],
    });

    try {
      const observer = new PerformanceObserver((list) => {
        for (const entry of list.getEntries()) {
          if (
            entry.startTime >= state.intervalStartedAt &&
            state.longTasks.length < 1000
          )
            state.longTasks.push({
              startTime: entry.startTime,
              duration: entry.duration,
            });
        }
      });
      observer.observe({ type: "longtask", buffered: true });
      state.longTaskObserver = observer;
    } catch {
      // Long tasks are not exposed by every browser; frame sampling still works.
    }
    const frame = (time: number) => {
      if (state.lastFrame && state.frameGaps.length < 12000)
        state.frameGaps.push(time - state.lastFrame);
      state.lastFrame = time;
      requestAnimationFrame(frame);
    };
    requestAnimationFrame(frame);
  });
}

/** Return the current interval, optionally starting a fresh gesture interval. */
export async function readTreeAcceptanceProbe(
  page: Page,
  reset = false,
): Promise<AcceptanceSnapshot> {
  return page.evaluate((resetInterval) => {
    const state = (window as typeof window & { __treeAcceptance?: ProbeState })
      .__treeAcceptance;
    if (!state) throw new Error("Tree acceptance probe is not installed");
    for (const entry of state.longTaskObserver?.takeRecords() || []) {
      if (
        entry.startTime >= state.intervalStartedAt &&
        state.longTasks.length < 1000
      )
        state.longTasks.push({
          startTime: entry.startTime,
          duration: entry.duration,
        });
    }
    const sorted = [...state.frameGaps].sort((a, b) => a - b);
    const snapshot: AcceptanceSnapshot = {
      requests: state.requests.map((request) => ({ ...request })),
      firstGpuAt: state.firstGpuAt,
      firstPortraitUploadAt: state.firstPortraitUploadAt,
      portraitUploads: state.portraitUploads,
      resources: { ...state.resources },
      frames: {
        count: sorted.length,
        p95Ms: sorted[Math.floor(sorted.length * 0.95)] || 0,
        maxMs: sorted.at(-1) || 0,
        over50Ms: sorted.filter((gap) => gap > 50).length,
      },
      longTasks: state.longTasks.map((task) => ({ ...task })),
      now: performance.now(),
    };
    if (resetInterval) {
      state.frameGaps.length = 0;
      state.lastFrame = 0;
      state.longTasks.length = 0;
      state.intervalStartedAt = snapshot.now;
    }
    return snapshot;
  }, reset);
}
