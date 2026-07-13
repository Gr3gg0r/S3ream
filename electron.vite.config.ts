import { resolve } from "node:path";
import { defineConfig, externalizeDepsPlugin } from "electron-vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

export default defineConfig({
  main: {
    resolve: {
      alias: {
        "@shared": resolve(__dirname, "src/shared"),
      },
    },
    plugins: [externalizeDepsPlugin()],
    build: {
      outDir: "dist/main",
      emptyOutDir: true,
    },
  },
  preload: {
    resolve: {
      alias: {
        "@shared": resolve(__dirname, "src/shared"),
      },
    },
    plugins: [externalizeDepsPlugin()],
    // electron-vite 5 forces `ssr.noExternal: true` for preloads; under Vite 8
    // (rolldown) that overrides rollupOptions.external and inlines the electron
    // npm shim, which breaks `ipcRenderer`/`contextBridge` in sandboxed preloads.
    // Re-externalize electron at the SSR level so the bundle keeps
    // `require("electron")` and Electron injects the real module at runtime.
    ssr: {
      external: ["electron"],
    },
    build: {
      outDir: "dist/preload",
      emptyOutDir: true,
      rollupOptions: {
        output: {
          // Sandboxed preloads only execute classic scripts, so the bundle
          // must stay CJS even though the package is ESM ("type": "module").
          format: "cjs",
          entryFileNames: "[name].cjs",
        },
      },
    },
  },
  renderer: {
    resolve: {
      alias: {
        "@renderer": resolve(__dirname, "src/renderer/src"),
        "@shared": resolve(__dirname, "src/shared"),
      },
    },
    plugins: [react(), tailwindcss()],
    build: {
      outDir: "dist/renderer",
      emptyOutDir: true,
    },
  },
});
