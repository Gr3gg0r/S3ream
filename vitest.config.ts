import { configDefaults, defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

const r = (p: string) => fileURLToPath(new URL(p, import.meta.url));

// Integration tests talk to a live RustFS container and FFmpeg binaries.
// They only run with `pnpm run test:integration` (S3REAM_TEST_INTEGRATION=1).
const runIntegration = process.env.S3REAM_TEST_INTEGRATION === "1";

export default defineConfig({
  resolve: {
    alias: [
      // Plain Node cannot load the electron API; swap in the mock.
      { find: /^electron$/, replacement: r("./tests/mocks/electron.ts") },
      { find: /^@main\/(.*)$/, replacement: r("./src/main/$1") },
      { find: /^@preload\/(.*)$/, replacement: r("./src/preload/$1") },
      { find: /^@renderer\/(.*)$/, replacement: r("./src/renderer/src/$1") },
      { find: /^@shared\/(.*)$/, replacement: r("./src/shared/$1") },
    ],
  },
  test: {
    include: ["tests/**/*.test.{ts,tsx}"],
    exclude: runIntegration
      ? [...configDefaults.exclude]
      : [...configDefaults.exclude, "tests/integration/**"],
    environment: "node",
    setupFiles: ["./tests/setup.ts"],
    testTimeout: 30_000,
    hookTimeout: 60_000,
  },
});
