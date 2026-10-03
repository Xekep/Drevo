import { defineConfig } from "vite";
import { transformAsync } from "@babel/core";
import react from "@vitejs/plugin-react";
import { resolve } from "node:path";

export default defineConfig({
  plugins: [
    {
      name: "bookreader-decorators",
      enforce: "pre",
      async transform(code, id) {
        if (
          !id
            .replaceAll("\\", "/")
            .includes("/node_modules/@internetarchive/bookreader/src/") ||
          !id.endsWith(".js")
        )
          return;
        // Match upstream babel.config.cjs: Lit 2 uses the 2018-09 decorator
        // proposal, whose field semantics differ from TypeScript decorators.
        const result = await transformAsync(code, {
          filename: id,
          babelrc: false,
          configFile: false,
          sourceMaps: true,
          plugins: [
            [
              "@babel/plugin-proposal-decorators",
              { version: "2018-09", decoratorsBeforeExport: true },
            ],
            "@babel/plugin-transform-class-properties",
          ],
        });
        if (result?.code) return { code: result.code, map: result.map };
      },
    },
    react(),
  ],
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
