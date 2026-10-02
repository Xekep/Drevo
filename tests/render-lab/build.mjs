import { build } from "vite";
import react from "@vitejs/plugin-react";
import { resolve, relative, isAbsolute, basename, dirname } from "node:path";

if (!process.env.DREVO_RENDER_LAB_DIST)
  throw new Error("Set DREVO_RENDER_LAB_DIST to a disposable output directory");
const repository = resolve(import.meta.dirname, "../..");
const output = resolve(process.env.DREVO_RENDER_LAB_DIST);
if (
  basename(output) !== "bundle" ||
  basename(dirname(output)) !== "drevo-render-lab"
)
  throw new Error(
    "Output must be a disposable drevo-render-lab/bundle directory",
  );
const withinRepository = relative(repository, output);
if (
  !withinRepository ||
  (!withinRepository.startsWith("..") && !isAbsolute(withinRepository))
)
  throw new Error(
    "The disposable benchmark output must be outside the repository",
  );

// Separate output: this experiment is never included in the application bundle.
await build({
  configFile: false,
  root: repository,
  base: "/render-lab/",
  plugins: [react()],
  worker: { format: "es" },
  build: {
    outDir: output,
    emptyOutDir: true,
    rolldownOptions: { input: resolve(import.meta.dirname, "index.html") },
  },
});
