import { defineConfig } from "vite";
import { resolve } from "path";

export default defineConfig({
  build: {
    rollupOptions: {
      input: {
        inject: resolve(__dirname, "src/inject.ts"),
        "content-script": resolve(__dirname, "src/content-script.ts"),
        "service-worker": resolve(__dirname, "src/service-worker.ts"),
        popup: resolve(__dirname, "popup/popup.ts"),
      },
      output: {
        entryFileNames: "[name].js",
        chunkFileNames: "chunks/[name].js",
        assetFileNames: "assets/[name].[ext]",
        // Reason: Chrome 120 supports ESM natively; iife requires codeSplitting=false
        // which Vite 8 disallows for multi-entry builds.
        format: "es",
      },
    },
    outDir: "dist",
    emptyOutDir: true,
    target: "chrome120",
    minify: false,
  },
  resolve: {
    alias: { "@": resolve(__dirname, "src") },
  },
});
