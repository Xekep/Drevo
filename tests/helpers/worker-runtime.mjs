// Модель API Worker для проверки собранного JS в Node. Не заменяет проверку браузером.
import { Worker, parentPort, workerData } from "node:worker_threads";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
globalThis.self = globalThis;
globalThis.postMessage = (value) => parentPort.postMessage(value);
const children = new Set();
globalThis.Worker = class {
  constructor(url) {
    const asset = String(url).startsWith("/assets/")
      ? pathToFileURL(resolve(workerData.dist, String(url).slice(1))).href
      : String(url);
    this.worker = new Worker(new URL(import.meta.url), {
      workerData: { url: asset, dist: workerData.dist },
    });
    children.add(this.worker);
    this.worker.on("message", (data) => this.onmessage?.({ data }));
    this.worker.on("error", (error) => {
      if (this.onerror) this.onerror(error);
      else throw error;
    });
  }
  postMessage(value) {
    this.worker.postMessage(value);
  }
  terminate() {
    children.delete(this.worker);
    void this.worker.terminate();
  }
};
const loaded = import(workerData.url);
parentPort.on("message", async (data) => {
  await loaded;
  await self.onmessage({ data });
});
parentPort.on("close", () => {
  for (const child of children) void child.terminate();
});
