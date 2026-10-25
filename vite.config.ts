import { defineConfig } from "vite";
import { transformAsync } from "@babel/core";
import react from "@vitejs/plugin-react";
import { resolve } from "node:path";

export default defineConfig({
  resolve: {
    alias: [
      {
        find: /^@vladmandic\/human$/,
        replacement: resolve(
          import.meta.dirname,
          "node_modules/@vladmandic/human/dist/human.esm-nobundle.js",
        ),
      },
    ],
  },
  plugins: [
    {
      name: "chunk-size-budgets",
      generateBundle(_, bundle) {
        for (const output of Object.values(bundle)) {
          if (output.type !== "chunk") continue;
          const modules = Object.keys(output.modules);
          // Upstream ships the complete Langium parser as one indivisible module.
          const standaloneParser =
            modules.length === 1 &&
            modules[0]
              .replaceAll("\\", "/")
              .includes("/node_modules/@mermaid-js/parser/dist/");
          const budget = standaloneParser ? 700_000 : 500_000;
          const bytes = Buffer.byteLength(output.code, "utf8");
          if (bytes > budget)
            this.error(
              `${output.fileName}: ${bytes} bytes exceeds the ${budget}-byte JavaScript budget`,
            );
        }
      },
    },
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
    // The plugin above enforces 500 kB for normal chunks, 700 kB only for
    // the standalone upstream parser. Violations fail, rather than warn.
    chunkSizeWarningLimit: 700,
    rolldownOptions: {
      onLog(level, log, handler) {
        handler(level === "warn" ? "error" : level, log);
      },
      input: {
        main: resolve(import.meta.dirname, "index.html"),
        bookreader: resolve(import.meta.dirname, "bookreader-frame.html"),
      },
      output: {
        // TensorFlow registers kernels/backends during module initialization.
        strictExecutionOrder: true,
        codeSplitting: {
          groups: [
            {
              name: "spatial",
              test: /node_modules[\\/]three[\\/]/,
              maxSize: 350_000,
            },
            {
              name: "charts",
              test: /node_modules[\\/](?:echarts|zrender)[\\/]/,
              maxSize: 350_000,
            },
            {
              name: "editor",
              test: /node_modules[\\/](?:@codemirror|@lezer)[\\/]/,
              maxSize: 350_000,
            },
            {
              name: "pdf",
              test: /node_modules[\\/](?:jspdf|svg2pdf\.js)[\\/]/,
              maxSize: 350_000,
            },
            {
              name: "vision",
              test: /node_modules[\\/](?:@tensorflow|@vladmandic)[\\/]/,
              maxSize: 350_000,
            },
          ],
        },
      },
    },
  },
  // Layout worker создаётся как `type: "module"`, поэтому и production bundle
  // собираем как ES module вместо дефолтного IIFE. Так сохраняются нативные
  // module-worker semantics и Rolldown не требует бессмысленный IIFE global name.
  worker: { format: "es" },
});
