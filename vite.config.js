import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  root: ".",
  publicDir: "public", // copies public/* to dist/
  build: {
    outDir: "dist",
    emptyOutDir: true,
    rollupOptions: {
      input: {
        background: "src/background/background.js",
        content: "src/content/index.js",
      },
      output: {
        // emit bundles at the exact paths used in manifest.json
        entryFileNames: (chunk) => {
          if (chunk.name === "background") {
            return "src/background/background.js";
          }
          if (chunk.name === "content") {
            return "src/content/index.js";
          }
          return "assets/[name].js";
        },
      },
    },
  },
});
