# Changelog

All notable changes to this project are documented in this file.

## [Unreleased]

### Fixed

- **Skip ping for providers without API key**: Providers that require authentication (not in `kilocode` or `opencode`) are no longer pinged when no API key is configured. Instead they are marked "No Auth" immediately, avoiding false positives in the model table.
- **Intelligence scores for all 164 models**: Added missing `MODEL_ID_ALIASES` entries and scores for SambaNova, iFlow, and other providers whose model ID formats didn't match the scores.js key format. All models now display their SWE-bench tier instead of "Unknown".

## [1.11.0] - 2026-03-21

### Added

- **Sources sync script** (`scripts/sync-sources.js`): Merges upstream model definitions from [free-coding-models](https://github.com/vava-nessa/free-coding-models) into local `sources.js`. Run with `npm run sync:sources` or preview with `npm run sync:sources:dry`.
- **Dashboard stability scores**: New sortable "Stability" column in the web dashboard. Displays a 0-100 stability score per model based on ping latency patterns. Color-coded: green (70+), light green (50-70), yellow (30-50), red (<30).
- **stabilityScore API field**: `/api/models` endpoint now returns a `stabilityScore` field per model. Computed from ping history using: p95 latency (30%), jitter (30%), spike rate (20%), uptime (20%). Returns `null` until enough pings accumulate.
- **GitHub Actions GHCR workflow** (`.github/workflows/docker.yml`): Auto-builds and publishes Docker image to GHCR on every push to `master`/`main` and on version tags (`v*`). Uses `linux/amd64` only. Image available at `ghcr.io/stgreenb/modelrelay`.

### Changed

- **Docker compose**: Removed invalid `proxy:` block. Changed from `build: .` to use GHCR image `ghcr.io/stgreenb/modelrelay:master` directly. HTTP_PROXY/HTTPS_PROXY/NO_PROXY are passed as standard environment variables. Named volume `modelrelay_config` persists API keys and settings at `/app/config`.
- **Dockerfile**: Uses `npm ci --omit=dev` for reproducible builds. Removed git dependency (was only needed for pnpm).

### Documentation

- **AGENTS.md**: Added Sources Sync section documenting the `free-coding-models-src/` dependency, model array format differences between modelrelay and upstream, and sync script usage.

## [Prior Versions]

See git history for releases before 1.11.0.
