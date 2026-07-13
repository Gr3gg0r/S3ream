# AGENTS.md — S3ream

> This file is for AI coding agents. It describes the project architecture, conventions, and workflows. The project uses English for all code comments and documentation.

---

## Project Overview

`S3ream` is an Electron desktop application that ingests MP4 (and other FFmpeg-compatible) video files, converts them to multi-bitrate HLS, and uploads the generated assets to an S3-compatible object store.

The philosophy is deliberately straightforward: running a server just to convert video to HLS is an unnecessary burden. Conversion happens locally on the user's machine (bundled FFmpeg), producing a proper adaptive HLS stream (master manifest + renditions), which is then uploaded directly to the user's chosen S3-compatible endpoint. No transcoding backend, no third-party service in the middle.

The app has three views, switched from the header:

- **Simple** (default): a 3-step wizard — drop a video, pick renditions, choose a destination (local folder or S3), convert.
- **Advanced**: the original two operation modes:
  - **Single file**: Convert and upload one video with live progress feedback.
  - **Folder batch**: Scan a folder, queue multiple videos, and process them with configurable concurrency.
- **History**: review past jobs, search by filename, filter by status, copy manifest URLs in bulk, and delete entries.

---

## Technology Stack

| Layer              | Technology                                                                       |
| ------------------ | -------------------------------------------------------------------------------- |
| Runtime            | Electron 43.1.0 (Node ^20.19.0 or ≥ 22.12.0)                                     |
| Toolchain Pinning  | proto (`.prototools`: Node 22.23.1, pnpm 8.15.4)                                 |
| Package Manager    | pnpm 8.15.4                                                                      |
| Build Tool         | electron-vite 5 (Vite 8 + Rolldown for main/preload/renderer)                    |
| Renderer Framework | React 19 + TypeScript ~5.9 (TS 7 breaks typescript-eslint — see below)           |
| Renderer Bundler   | Vite 8 with `@vitejs/plugin-react` and `@tailwindcss/vite`                       |
| Styling            | Tailwind CSS 4 + DaisyUI 5 (CSS-first config, no JS theme config)                |
| Video Processing   | FFmpeg / FFprobe via `@ffmpeg-installer/ffmpeg` and `@ffprobe-installer/ffprobe` |
| S3 Client          | `minio` JavaScript package (vendor-neutral S3 client)                            |
| Tests              | Vitest 4 + Testing Library (unit/jsdom) + opt-in integration vs RustFS           |
| Process Spawning   | `execa` 9.x                                                                      |
| Environment Config | `dotenv` (loaded in main process)                                                |

> **TypeScript is pinned to ~5.9 on purpose.** TS 7 (the native port) removed
> `baseUrl`/`moduleResolution: "node"` and, more importantly, breaks
> typescript-eslint 8's type-aware parsing (`ts.ModuleKind` shape changed).
> Only bump past 5.x once typescript-eslint declares TS 7 support.

---

## Project Structure

```
.
├── .github/workflows/ci.yml    # CI: lint, typecheck, tests, build (+ integration vs RustFS)
├── .prototools                 # proto toolchain lock: Node 22.23.1, pnpm 8.15.4
├── build/                      # electron-builder resources: icon.png (1024 master), icon.icns, icon.ico
├── docker-compose.yml          # RustFS + Toxiproxy stack for local dev
├── docs/screenshots/           # README screenshots (regenerate from the running app when the UI changes)
├── electron.vite.config.ts     # Build configuration for main/preload/renderer
├── NOTICE                      # Third-party attributions incl. the FFmpeg GPL-3.0 notice
├── package.json
├── pnpm-lock.yaml
├── tsconfig.base.json          # Shared TS compiler options and path aliases
├── tsconfig.json               # Project references root
├── tsconfig.node.json          # Main + preload + shared + build scripts
├── tsconfig.renderer.json      # Renderer + shared
├── eslint.config.mjs           # ESLint flat config (TS + React + Prettier)
├── prettier.config.cjs
├── scripts/
│   ├── bootstrap-toxiproxy.sh  # Configures latency/bandwidth toxics
│   └── prune-platform-binaries.cjs # electron-builder afterPack: strips non-target FFmpeg/FFprobe binaries
├── tests/
│   ├── mocks/electron.ts       # Electron module mock (aliased in vitest.config.ts)
│   ├── setup.ts                # Per-file isolated userData dir
│   ├── main/                   # Unit tests for main-process services
│   ├── renderer/               # jsdom renderer smoke tests
│   └── integration/            # Opt-in: real FFmpeg + live RustFS round trips (shared helpers in helpers.ts)
└── src/
    ├── main/
    │   ├── index.ts              # Electron main process entry (window, IPC handlers)
    │   └── services/
    │       ├── jobManager.ts     # Queue orchestration, deduplication, concurrency
    │       ├── videoPipeline.ts  # FFmpeg HLS encoding + S3 upload
    │       ├── minioClient.ts    # S3 client factory, URL builders
    │       ├── historyService.ts # JSON-backed history persistence
    │       └── settingsService.ts # S3 connection settings, safeStorage-encrypted secrets
    ├── preload/
    │   └── index.ts              # Context bridge exposing typed API to renderer
    ├── renderer/
    │   ├── index.html            # HTML shell with CSP meta tag + pre-React theme script
    │   ├── public/theme-init.js  # Applies stored theme before React mounts (no flash); mirrors useTheme.ts
    │   └── src/
    │       ├── main.tsx          # React root mount
    │       ├── App.tsx           # App shell: header, view switch, Advanced (single/batch) + History views
    │       ├── index.css         # Tailwind 4 import, DaisyUI 5 theme blocks, .linear-* component classes
    │       ├── components/
    │       │   ├── JourneyWizard.tsx # Simple view: 3-step wizard (Video → Quality → Destination → Convert)
    │       │   ├── DropZone.tsx    # Dashed drop area + click-to-browse for the wizard
    │       │   ├── RenditionPicker.tsx # Shared rendition toggle buttons (Simple + Advanced)
    │       │   ├── ThemeToggle.tsx # System/Light/Dark segmented control
    │       │   └── icons.tsx       # Inline stroke SVG icons (currentColor, 16px default)
    │       └── hooks/
    │           ├── useTheme.ts     # Theme preference (localStorage s3ream-theme) + data-theme sync
    │           └── useDialogA11y.ts # Modal focus trap, ESC close, focus restore
    └── shared/
        └── ipc.ts               # Canonical IPC types, SUPPORTED_VIDEO_EXTENSIONS, global Window extension
```

---

## Build & Development Commands

All commands run through `pnpm`.

```bash
# Install dependencies
pnpm install

# Start development (Electron main + Vite renderer dev server + preload watcher)
pnpm run dev

# Dev against different environment files
pnpm run dev:slow        # loads .env.slow (Toxiproxy slow endpoint)
pnpm run dev:testing     # loads .env.testing
pnpm run dev:staging     # loads .env.staging
pnpm run dev:production  # loads .env.production

# Production build (outputs to dist/main, dist/preload, dist/renderer)
pnpm run build

# Preview the production build locally
pnpm run preview

# Lint TypeScript sources
pnpm run lint            # eslint . (flat config, type-aware)

# Type-check everything (main, preload, renderer, shared, tests)
pnpm run typecheck       # tsc -p tsconfig.typecheck.json --noEmit

# Format with Prettier
pnpm run format          # prettier --write .

# Tests
pnpm run test            # Vitest unit + renderer suites (no external services)
pnpm run test:watch      # Watch mode
pnpm run test:integration  # Full suite: real FFmpeg + live RustFS (needs docker compose up -d)
```

## Testing

Vitest 4 is configured in `vitest.config.ts`:

- **Unit tests** (`tests/main/**`, `tests/renderer/**`) run in plain Node/jsdom. The `electron` module is aliased to `tests/mocks/electron.ts` (plain `require("electron")` in Node returns a binary path, not the API). `tests/setup.ts` points `S3REAM_TEST_USER_DATA` at a fresh temp dir per test file so the `historyService` singleton stays isolated.
- **Integration tests** (`tests/integration/**`) are excluded unless `S3REAM_TEST_INTEGRATION=1` (set by `pnpm run test:integration`). They need the RustFS stack up (`docker compose up -d`); override the endpoint with `S3_TEST_ENDPOINT_URL` when using alternate ports. Each suite creates its own bucket and cleans up after itself. They self-skip when the endpoint is unreachable.
- Internal helpers in the services are exported specifically for unit tests (e.g. `determineVariantProfiles`, `createMasterManifest`, `convertToHls`, `normalizePrefix`, `deriveObjectKey`, `parseEndpoint`). Keep these exports stable; tests import them directly.
- Test files are type-checked through `tsconfig.node.json` (`tests/**/*.ts`) and `tsconfig.renderer.json` (`tests/renderer`) — new test directories must be added to the matching tsconfig include or ESLint's type-aware parser will reject them.
- The bundled FFmpeg/FFprobe binaries may lack the execute bit after installs that skip package scripts; integration tests `chmod 0o755` them in `beforeAll`, mirroring `prepareBinaries()`.

---

## Environment Configuration

The main process loads `dotenv/config` at startup, so `.env` variables are available in the main process and in `electron.vite.config.ts` (via `loadEnv`).

Copy `.env.example` to `.env` and adjust values:

| Variable                     | Purpose                                                    |
| ---------------------------- | ---------------------------------------------------------- |
| `S3_REGION`                  | Region identifier (e.g., `us-east-1`)                      |
| `S3_ACCESS_KEY_ID`           | S3 access key                                              |
| `S3_SECRET_ACCESS_KEY`       | S3 secret key                                              |
| `S3_BUCKET_NAME`             | Target bucket                                              |
| `S3_ENDPOINT_URL`            | S3 API base URL (e.g., `http://localhost:9000` for RustFS) |
| `S3_USE_PATH_STYLE_ENDPOINT` | `true` for self-hosted path-style stores (RustFS, MinIO)   |
| `S3_BUCKET_URL`              | Base URL used to construct public links                    |
| `S3_VIEW_ENDPOINT`           | Optional CDN or view base for manifests                    |
| `S3_UPLOAD_CONCURRENCY`      | Parallel upload workers (default 4, max 16)                |

The renderer currently reads no env vars — all S3 configuration is consumed in the main process. If a future variable is needed in React code, expose it via `loadEnv` + a `renderer.define` entry in `electron.vite.config.ts`.

---

## Local Development Stack (Docker)

A RustFS server and optional Toxiproxy are provided via `docker-compose.yml`:

```bash
docker compose up -d
```

Services:

- **RustFS** on `http://localhost:9000` (API) and `http://localhost:9001` (Console) — Apache-2.0 S3-compatible store, drop-in local replacement for MinIO
- **Toxiproxy** on `http://localhost:8474` (API) and `http://localhost:8666` (proxied S3)
- **s3-bootstrap** (AWS CLI) auto-creates the bucket and applies a public-read policy
- **toxiproxy-bootstrap** adds latency (400ms ± 120ms jitter) and bandwidth limits (50kbps) to simulate slow networks

Default credentials: `rustfsadmin / rustfsadmin`.

---

## Architecture Details

### Electron Process Model

- **Main process** (`src/main/index.ts`): Creates the `BrowserWindow`, registers `ipcMain` handlers, and delegates all heavy work to services.
- **Preload** (`src/preload/index.ts`): Exposes a single typed `window.api` object via `contextBridge`. No Node APIs leak into the renderer.
- **Renderer** (`src/renderer/src/App.tsx`): React SPA that communicates only through `window.api`. The header switches between three views persisted in localStorage (`s3ream-view`): **Simple** (the `JourneyWizard` 3-step flow), **Advanced** (the original single/batch UI behind a secondary toggle), and **History**.
- The main process takes `app.requestSingleInstanceLock()` at startup; a second instance quits immediately and focuses the existing window (a second instance would otherwise sweep the first instance's live temp dirs and race history writes).

Window settings:

- `nodeIntegration: false`
- `contextIsolation: true`
- `sandbox: true` (the preload only uses `ipcRenderer`/`contextBridge`, which work sandboxed — keep it that way)

The preload bundle must keep `require("electron")` external — if the electron npm shim gets inlined, `window.api` silently disappears and the renderer shows "Native bridge unavailable". electron-vite 5 force-sets `ssr.noExternal: true` for preloads, which under Vite 8 (rolldown) overrides `rollupOptions.external`; the config therefore re-externalizes electron via `preload.ssr.external: ["electron"]` in `electron.vite.config.ts`. After touching the build config, verify `dist/preload/index.cjs` starts with `require("electron")`.

### IPC Contracts

All IPC payloads are defined in `src/shared/ipc.ts`. The `ExposedBridge` interface and the global `Window` extension must stay in sync with the preload script and main handlers.

Key channels:

- `dialog:select-video` / `dialog:select-folder`
- `jobs:scan-folder` / `jobs:queue` / `jobs:process-single` / `jobs:control` / `jobs:set-concurrency`
- `jobs:single-progress` (renderer → main push for single-file mode)
- `jobs:update` / `jobs:log` (main → renderer push for batch mode)
- `history:list` / `history:delete`
- `settings:get` / `settings:save` (S3 connection settings; secrets stay main-side, the renderer only sees `hasAccessKey`/`hasSecretKey`)

`SUPPORTED_VIDEO_EXTENSIONS` is exported from `src/shared/ipc.ts` and shared by the main-process queue validation and the renderer DropZone. `jobs:process-single` accepts an optional `destination` (`{ type: "s3" }` or `{ type: "local", directory }`); local jobs skip the upload and return the manifest file path in `manifestUrl`.

### Video Pipeline (`videoPipeline.ts`)

1. **Probe**: FFprobe reads width, height, duration, frame rate.
2. **Filter renditions**: Skips profiles taller than the source. Falls back to the largest fitting profile if none match.
3. **Encode variants**: FFmpeg encodes each variant to HLS (TS segments + `index.m3u8`).
4. **Master manifest**: A `master.m3u8` is generated with `BANDWIDTH`, `RESOLUTION`, `FRAME-RATE`, and `CODECS` attributes.
5. **Upload or copy**: Files are streamed to S3 with a configurable worker pool, or copied to the chosen local folder when the job destination is `{ type: "local" }` (no S3 client is created on that path).
6. **Cleanup**: Temp directory is deleted on every exit path (encode failures included); orphaned `s3ream-hls-*` dirs are also swept from `os.tmpdir()` at startup.

Variant profiles range from 240p to 4K with x264 presets (`veryfast`), AAC audio, and 6-second HLS segments.

Cancellation threads an `AbortSignal` through probe, encode (execa `cancelSignal` — execa 9 silently ignores the plain `signal` option), and upload (in-flight read streams are destroyed). Canceled or failed jobs may leave partial objects in the bucket by design: re-running the same file and prefix derives the same object key and overwrites, so no best-effort S3 cleanup runs on failure (it could destroy a previously successful upload at the same key).

### Job Manager (`jobManager.ts`)

- Maintains an ordered queue of `InternalJob` objects.
- Supports concurrency 1–16 (default 2).
- Deduplicates against the history store: if a `(filePath, basePrefix)` pair was already completed, the job is skipped.
- Unsupported extensions are skipped immediately.
- Power-save blocker is refcounted: the batch queue holds it while active and each single-file conversion holds its own, so overlapping holds never switch each other off.
- Overlapping `processSingle` calls for the same `(filePath, basePrefix)` are rejected — they would derive the same object key and clobber each other's output.
- Queue controls: `pause`, `resume`, `cancel-current`, `cancel-remaining`, `clear-completed`. `cancel-current` aborts the running FFmpeg process and in-flight uploads via an `AbortController` threaded through `processVideoJob`.

### History Service (`historyService.ts`)

- Persists to `history.json` inside the Electron `userData` directory. Writes are atomic (temp file + rename); an unreadable store is moved aside to `history.json.corrupt-<timestamp>` for manual recovery before a fresh store is written.
- Stores jobs (capped at 2000 records) and per-job logs (capped at 5000 log entries globally). Log writes are debounced (1s) to avoid main-thread stalls during long batches; job state transitions save immediately and `flush()` runs on app quit. At startup, records left in an active state by a previous crash are marked failed ("Interrupted by app restart").
- Supports search (filename, path, prefix) and status filtering.

### Settings Service (`settingsService.ts`)

- Persists S3 connection settings to `settings.json` inside the Electron `userData` directory. Writes are atomic (temp file + rename); a stored file with a missing or malformed `secrets` block is ignored instead of crashing startup.
- Secrets are encrypted at rest via `safeStorage` when the OS keychain is available, with an honest plaintext fallback (`getView().encryptionAvailable` tells the renderer which mode is active).
- Empty secret fields on save mean "keep the stored value". The renderer-facing view only exposes `hasAccessKey` / `hasSecretKey` — raw secrets never cross IPC.
- Undecryptable secrets (lost keychain entry) are treated as unset with a warning instead of crashing startup.

### S3 Client (`minioClient.ts`)

- Uses the `minio` npm package, but works with any S3-compatible endpoint; local development targets RustFS.
- `ensureBucket` creates the bucket if missing and applies a public-read policy.
- `buildPublicUrl` constructs URLs from view endpoint → bucket URL fallback.
- `configureS3(settings)` applies saved settings at runtime (called at startup and on `settings:save`); non-empty fields win over env vars and the cached client is reset. `getActiveBucketName()` resolves the bucket with the same precedence.

---

## Code Style Guidelines

- **Formatter**: Prettier (semicolons, double quotes, trailing commas, 100 print width, 2-space tabs).
- **Linter**: ESLint flat config with TypeScript, React, and React Hooks rules.
- **TypeScript**: Strict mode enabled. `noUnusedLocals`, `noUnusedParameters`, and `noImplicitReturns` are enforced. Unused variables will fail compilation.
- **Imports**: Use path aliases (`@renderer/*`, `@shared/*`).
- **Renderer imports**: `@renderer` resolves to `src/renderer/src`.
- **File naming**: kebab-case for configs, camelCase for source files.

### React Conventions in App.tsx

- Single large functional component (`App`) with many `useState`/`useEffect` hooks; the Simple journey lives in `components/JourneyWizard.tsx` and talks to `window.api` directly.
- Theme is user-selectable via `useTheme()` (`"system" | "light" | "dark"`, localStorage key `s3ream-theme`); `"system"` tracks OS `prefers-color-scheme: dark` live. Modals use `useDialogA11y()` for focus trapping, ESC close, and focus restore.
- The UI follows an Apple glassmorphism design language on a shot.so-style gradient mesh: the app root uses `.glass-canvas` (fixed radial-gradient blobs, per-theme in `index.css`), and panels are frosted glass (`.linear-card` — `backdrop-filter: blur(24px) saturate(180%)`, translucent per-theme backgrounds, 16px radii, soft diffused shadows). Reusable component classes (`linear-card`, `linear-well`, `linear-btn*`, `linear-input`, `linear-select`, `linear-label`, `linear-hint`, `linear-badge*`, `linear-table`, `linear-thead`, `linear-segmented`, `linear-progress`, `linear-alert*`, `linear-mono`, `linear-dropzone`) live in `@layer components` in `src/renderer/src/index.css`; glass/translucent values are scoped via `[data-theme="s3ream"]` / `[data-theme="s3reamdark"]` selectors, while accent-driven values reference DaisyUI 5 CSS variables (`var(--color-…)`). Prefer these classes over raw DaisyUI component classes (`btn`, `card`, `badge`, `table`, `alert`) when touching the renderer; only `card-body` (padding) and `checkbox checkbox-sm` (restyled globally) remain in use. New translucent surfaces must NOT use solid `bg-base-*` — glass only reads against the gradient canvas.
- Typography is Inter, loaded via `@fontsource/inter` imports in `src/renderer/src/main.tsx` (400/500/600/700), with Tailwind utilities used inline for one-off tweaks; there are no separate CSS modules for components.

---

## Security Considerations

1. **CSP**: `index.html` sets a strict Content-Security-Policy (`default-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:`).
2. **No remote content**: The renderer does not load remote scripts or iframes.
3. **Context isolation**: Preload runs in an isolated context; only `window.api` is exposed.
4. **Sandbox enabled**: `sandbox: true` — the preload must stick to `ipcRenderer`/`contextBridge` only. Never expose raw `ipcRenderer` or Node-capable APIs through `window.api`.
5. **S3 credentials**: Stored in `.env` files. All `.env*` files are gitignored except `.env.example` and `.env.slow`, which are intentionally tracked and contain only local RustFS/Toxiproxy defaults. Never commit credentials.
6. **Bucket policy**: The app automatically applies a public-read policy to the target bucket. Ensure this is acceptable for your deployment.
7. **Temp files**: HLS artifacts are written to `os.tmpdir()` and cleaned up on every job exit path; any orphans from a crash are swept at the next startup.

---

## Adding Features / Common Tasks

### Adding a new IPC channel

1. Add request/response types to `src/shared/ipc.ts`.
2. Add the handler in `src/main/index.ts` using `ipcMain.handle(...)`.
3. Expose the method in `src/preload/index.ts` inside the `api` object.
4. Consume it in `src/renderer/src/App.tsx` via `window.api`.

### Adding a new env var to the renderer

Vite does not automatically expose `process.env` to the renderer, and the renderer currently reads none. If a variable is ever needed in React code:

1. Load it in `electron.vite.config.ts` using `loadEnv` (re-add the `({ mode })` param).
2. Add a `renderer.define` entry so it is replaced at build time.

### Changing DaisyUI themes

Themes are defined CSS-first in `src/renderer/src/index.css` via `@plugin "daisyui/theme"` blocks (DaisyUI 5 has no JS theme config — there is no `tailwind.config.cjs`). Each block is a fully-specified token set (no theme inheritance). The palette is monochrome black & white, flipped between themes — only the status colors (info/success/warning/error) carry hue, and they are for badges/alerts only:

- Light: `s3ream` — white surfaces on a `#FAFAFA` base, `#0A0A0A` primary/content (`default: true`)
- Dark: `s3reamdark` — `#141414` surfaces on a `#0A0A0A` base, `#FAFAFA` primary/content (`prefersdark: true`)

Both themes share the same radius/border tokens (`--radius-box: 1rem`, `--radius-field: 0.625rem`, `--radius-selector: 9999px`, `--border-field: 1px`). The `@theme` block in the same file registers Inter as `--font-sans`. The component classes in `index.css` read accent colors through DaisyUI 5 CSS variables (`var(--color-primary)`, `var(--color-base-content)`, etc. — the v4 `oklch(var(--p))` shorthand is gone) and glass translucency through `[data-theme="…"]` selectors, so changing a token in a theme block restyles the whole UI. The `.glass-canvas` blobs are grayscale and `.linear-progress` fills with solid `var(--color-primary)` — keep the monochrome constraint when adding surfaces.

The `<html>` tag in `index.html` defaults to `data-theme="s3ream"`, and `useTheme()` (`src/renderer/src/hooks/useTheme.ts`) applies `s3ream`/`s3reamdark` based on the stored preference (System/Light/Dark toggle in the header). `src/renderer/public/theme-init.js` applies the same logic before React mounts so the first paint already has the right theme — keep the two in sync when changing the preference logic.

---

## Deployment Notes

- Packaging uses `electron-builder` with configuration in `electron-builder.yml` (`appId: com.s3ream.app`, macOS dmg/zip for arm64+x64, Windows nsis/portable, Linux AppImage/deb). Build with `pnpm run dist` (or `dist:mac` / `dist:win` / `dist:linux`); artifacts are written to `release/${version}/`, which is gitignored.
- The `@ffmpeg-installer`/`@ffprobe-installer` platform packages carry no `os`/`cpu` constraints, so pnpm installs every variant. They are declared as `optionalDependencies` (electron-builder only bundles declared deps on pnpm 10+), and `scripts/prune-platform-binaries.cjs` (an `afterPack` hook) strips all but the target platform+arch — keep both in place or bundles double in size. When bumping the installer packages, bump the `optionalDependencies` versions to match.
- `build/` holds the app icons used as `buildResources`: a monochrome play/stream mark matching the app palette — `icon.png` (1024px master, also used for Linux), `icon.icns` (macOS), and `icon.ico` (Windows).
- CI runs on GitHub Actions (`.github/workflows/ci.yml`): a `check` job (lint, typecheck, unit tests, production build) and an `integration` job that brings up the RustFS Docker stack and runs `pnpm run test:integration`.
