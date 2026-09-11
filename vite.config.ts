import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  build: { outDir: "dist" },
  // Layout worker создаётся как `type: "module"`, поэтому и production bundle
  // собираем как ES module вместо дефолтного IIFE. Так сохраняются нативные
  // module-worker semantics и Rolldown не требует бессмысленный IIFE global name.
  worker: { format: "es" },
});
