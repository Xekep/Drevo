import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// The same interface can also be served by any ordinary static web server.
export default defineConfig({
  plugins: [react()],
  build: { outDir: "dist-static", emptyOutDir: true },
});
