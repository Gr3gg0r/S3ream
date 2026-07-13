# Contributing to S3ream

Thanks for helping out. The workflow is intentionally simple: fork, branch,
make the change, run the quality gate, open a PR.

## Setup

```bash
pnpm install
docker compose up -d   # RustFS (local S3) + Toxiproxy for slow-network testing
pnpm run dev
```

Node ^20.19.0 or ≥ 22.12.0 and pnpm 8 are required — or use [proto](https://moonrepo.dev/proto),
which reads the committed `.prototools` lock (`proto install`). See `README.md` for environment
variables and the Docker stack details.

## Before opening a PR

Run the full gate and keep it green:

```bash
pnpm run lint        # ESLint, zero warnings allowed
pnpm run format      # Prettier
pnpm run typecheck   # tsc over main, preload, renderer, shared, tests
pnpm run test        # Unit + renderer suites
pnpm run test:integration  # Needs the Docker stack up
```

Guidelines:

- **Tests**: add or extend tests for behavior changes. Main-process services
  have unit suites in `tests/main/**`; pure helpers are exported specifically
  so tests can import them directly — keep those exports stable. New test
  directories must be added to the matching tsconfig include or ESLint's
  type-aware parser will reject them.
- **Style**: let Prettier and ESLint decide formatting. TypeScript is strict
  with `noUnusedLocals`/`noUnusedParameters` — dead code fails the build.
- **Scope**: keep PRs focused; a small reviewable diff beats a sweeping one.
- **IPC changes** touch four places in lockstep: `src/shared/ipc.ts` (types),
  `src/main/index.ts` (handler), `src/preload/index.ts` (bridge), and the
  renderer consumer. Never expose raw `ipcRenderer` or Node-capable APIs
  through `window.api`.
- **Secrets**: never commit `.env` files or credentials. Only `.env.slow` is
  tracked, and it carries local-dev defaults only. End users configure
  everything in the app's settings UI — there is no `.env.example` to copy.

`AGENTS.md` documents the architecture, conventions, and common tasks in
detail — read it before non-trivial changes.

## Commit messages

Short imperative subject lines, e.g. `fix: abort in-flight uploads on cancel`.
Squash noisy work-in-progress commits before requesting review.

## Code of Conduct

All participation is covered by the [Code of Conduct](CODE_OF_CONDUCT.md).

## Security

Please do **not** open public issues for vulnerabilities — follow
[SECURITY.md](SECURITY.md) instead.
