import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { resolve } from "node:path";

export default defineConfig({
  plugins: [react()],
  build: {
    outDir: "dist",
    rolldownOptions: {
      input: {
        main: resolve(import.meta.dirname, "index.html"),
        bookreader: resolve(import.meta.dirname, "bookreader-frame.html"),
      },
    },
  },
  // Layout worker создаётся как `type: "module"`, поэтому и production bundle
  // собираем как ES module вместо дефолтного IIFE. Так сохраняются нативные
  // module-worker semantics и Rolldown не требует бессмысленный IIFE global name.
  worker: { format: "es" },
});
