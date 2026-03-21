# Changelog

All notable changes to this project are documented in this file.

## [Unreleased]

## [1.11.0] - 2026-03-21

### Added

- **Sources sync script** (`scripts/sync-sources.js`): Merges upstream model definitions from [free-coding-models](https://github.com/vava-nessa/free-coding-models) into local `sources.js`. Run with `npm run sync:sources` or preview with `npm run sync:sources:dry`.
- **Dashboard stability scores**: New sortable "Stability" column in the web dashboard. Displays a 0-100 stability score per model based on ping latency patterns. Color-coded: green (70+), light green (50-70), yellow (30-50), red (<30).
- **stabilityScore API field**: `/api/models` endpoint now returns a `stabilityScore` field per model. Computed from ping history using: p95 latency (30%), jitter (30%), spike rate (20%), uptime (20%). Returns `null` until enough pings accumulate.
- **Docker build fix**: Switched from pnpm to npm in Dockerfile to fix missing module errors. Added `.dockerignore` to exclude `node_modules/` from Docker context.

### Changed

- **Docker compose**: Removed invalid `proxy:` block from `docker-compose.yml` (not valid in Compose v2). HTTP_PROXY/HTTPS_PROXY/NO_PROXY are now passed as standard environment variables.
- **Dockerfile**: Uses `npm ci --omit=dev` for reproducible builds. Removed git dependency (was only needed for pnpm).

### Documentation

- **AGENTS.md**: Added Sources Sync section documenting the `free-coding-models-src/` dependency, model array format differences between modelrelay and upstream, and sync script usage.

## [Prior Versions]

See git history for releases before 1.11.0.
