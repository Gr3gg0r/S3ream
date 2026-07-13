import { resolve } from "node:path";
import { defineConfig, externalizeDepsPlugin } from "electron-vite";
import react from "@vitejs/plugin-react";
import { loadEnv } from "vite";

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), "");

  return {
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
          "@preload": resolve(__dirname, "src/preload"),
          "@main": resolve(__dirname, "src/main"),
          "@shared": resolve(__dirname, "src/shared"),
        },
      },
      define: {
        "process.env.S3_BUCKET_URL": JSON.stringify(env.S3_BUCKET_URL ?? ""),
        "process.env.S3_VIEW_ENDPOINT": JSON.stringify(env.S3_VIEW_ENDPOINT ?? ""),
        "process.env.S3_BUCKET_NAME": JSON.stringify(env.S3_BUCKET_NAME ?? ""),
      },
      plugins: [react()],
      build: {
        outDir: "dist/renderer",
        emptyOutDir: true,
      },
      css: {
        postcss: resolve(__dirname, "postcss.config.cjs"),
      },
    },
  };
});
