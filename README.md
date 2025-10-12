# mkp-upload-services

Electron desktop application that ingests MP4 or FFmpeg-compatible video files, converts them to HLS, and uploads the generated assets to an S3-compatible object store. The project is powered by TypeScript, React, DaisyUI, and pnpm, with environment-driven configuration and a local MinIO Docker stack for development.

## Prerequisites
- [pnpm](https://pnpm.io/) ≥ 8
- Node.js ≥ 18
- Docker & Docker Compose (for the bundled MinIO stack)
- FFmpeg (optional locally; the app ships with a bundled binary)

## Getting Started
```bash
pnpm install
pnpm run dev
```

The `dev` command starts the Electron main process, Vite dev server for the renderer, and watches the preload bundle.

### Building for Production
```bash
pnpm run build
pnpm run preview
```

## Environment Configuration
Copy `.env.example` to `.env` and update the values to match your S3-compatible object storage deployment:
```bash
cp .env.example .env
```

| Variable | Description |
| --- | --- |
| `S3_REGION` | Region for the bucket (e.g. `us-east-1`) |
| `S3_ACCESS_KEY_ID` | Access key for the S3-compatible endpoint |
| `S3_SECRET_ACCESS_KEY` | Secret key for the S3-compatible endpoint |
| `S3_BUCKET_NAME` | Target bucket for uploads |
| `S3_ENDPOINT_URL` | Base URL for the S3-compatible API (e.g. `https://s3.example.com`) |
| `S3_USE_PATH_STYLE_ENDPOINT` | `true` to force path-style requests (required for MinIO) |
| `S3_BUCKET_URL` | Bucket URL used when constructing public links (e.g. `https://s3.example.com/media`) |
| `S3_VIEW_ENDPOINT` | Optional fully-qualified base (such as a CDN) for viewing uploaded objects |

## MinIO via Docker
The included `docker-compose.yml` spins up a MinIO server with persistent storage.
```bash
docker compose up -d
```

The instance exposes:
- S3-compatible API on `http://localhost:9000`
- Console UI on `http://localhost:9001`

Credentials default to `minioadmin:minioadmin`. Update them in your `.env` file and Docker Compose if needed.

## UI & Theming
- Renderer built with React + Vite + TypeScript
- Tailwind CSS with DaisyUI for rapid styling
- Theme defaults to DaisyUI's `corporate` palette with blue highlights
- Dark mode follows the operating system preference automatically

## Video Conversion Flow
1. User selects a video file (MP4 or other FFmpeg-supported container) and chooses preferred output renditions (240p through 4K, defaulting to 360p/480p/720p).
2. Electron main process converts it to multi-bitrate HLS renditions (360p → 4K when supported) using the packaged FFmpeg toolchain.
3. Assets upload to the configured S3 bucket under the user-specified key.
4. Renderer displays the public download URL derived from `S3_VIEW_ENDPOINT` (when set) or `S3_BUCKET_URL`.

All long-running work is executed outside the renderer via IPC bridges exposed through the preload script.

## Project Structure
```
.
├── docker-compose.yml
├── electron.vite.config.ts
├── src
│   ├── main          # Electron main process code & backend services
│   ├── preload       # Secure bridge between renderer and main
│   └── renderer      # React + Vite front-end
├── tailwind.config.cjs
└── tsconfig*.json
```

## Recommended Commands
- `pnpm run lint` — ESLint over TypeScript sources
- `pnpm run format` — Format with Prettier (renderer + shared configs)
