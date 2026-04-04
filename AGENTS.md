# Agent Instructions

## Post-Feature Testing

After completing any feature or fix, the agent MUST:

1. Run `pnpm test` to verify all unit tests pass (62 tests across 11 suites)
2. If any test fails, fix the issue immediately
3. Re-run `pnpm test` until all tests pass

This ensures the codebase remains in a working state at all times.

## Git Commits

When making a commit on behalf of the user, NEVER prefix your commit message with `fix:`, `feature:`, `feat:`, `chore:`, or any other prefix. 
Just write a descriptive sentence of what was changed.

## Release Process (MANDATORY)

When releasing a new version, follow this exact process:

1. **Version Check**: Check if version already exists with `git log --oneline | grep "^[a-f0-9]\+ [0-9]"`
2. **Version Bump**: Update version in `package.json`. If the releas only includes bug 
fixes, bump a patch version  (e.g., `0.1.16` → `0.1.17`). If it includes new features, bump a minor version  (e.g., `0.1.16` → `0.2.0`)
Do not bump the major version.
3. **Commit ALL Changed Files**: `git add . && git commit -m "Fixed issue with autostart"`
   - Always commit using a description of what was changed as the commit message. 
   - Include ALL modified files in the commit (bin/, lib/, test/, README.md, etc.)
4. **Push**: `git push origin master` — this repo's release branch is `master`, and GitHub Actions will auto-publish to npm
5. **Create GitHub Release**:
   ```bash
   gh release create VERSION --title "VERSION" --notes "Release notes"
   ```
   (e.g., `gh release create 1.5.0 --title "1.5.0" --notes "Fixed an issue with ABC"`)
   When writing the release notes, summarize the changes from all commits since the last release.
6. **Wait for npm Publish":
   ```bash
   for i in $(seq 1 30); do sleep 10; v=$(npm view modelrelay version 2>/dev/null); echo "Attempt $i: npm version = $v"; if [ "$v" = "0.1.17" ]; then echo "✅ published!"; break; fi; done
   ```
7. **Install and Verify**: `npm install -g modelrelay@0.1.17`
8. **Test Binary**: `modelrelay --help` (or any other command to verify it works)
9. **Only when the global npm-installed version works → the release is confirmed**

**Why:** A local `npm install -g .` can mask issues because it symlinks the repo. The real npm package is a tarball built from the `files` field — only a real npm install will catch missing files.

## Real-World npm Verification (MANDATORY for every fix/feature)

**Never trust local-only testing.** `pnpm start` runs from the repo and won't catch missing files in the published package. Always run the full npm verification:

1. Bump version in `package.json` (e.g. `0.1.14` → `0.1.15`)
2. Commit and push to `master` — this repo's release branch is `master`, and GitHub Actions auto-publishes to npm
3. Wait for the new version to appear on npm:
   ```bash
   # Poll until npm has the new version
   for i in $(seq 1 30); do sleep 10; v=$(npm view modelrelay version 2>/dev/null); echo "Attempt $i: npm version = $v"; if [ "$v" = "NEW_VERSION" ]; then echo "✅ published!"; break; fi; done
   ```
4. Install the published version globally:
   ```bash
   npm install -g modelrelay@NEW_VERSION
   ```
5. Run the global binary and verify it works:
   ```bash
   modelrelay
   ```
6. Only if the global npm-installed version works → the fix is confirmed

**Why:** A local `npm install -g .` can mask issues because it symlinks the repo. The real npm package is a tarball built from the `files` field — if something is missing there, only a real npm install will catch it.

## Test Architecture

- Tests live in `test/test.js` using Node.js built-in `node:test` + `node:assert` (zero deps)
- Pure logic functions are in `lib/utils.js` (extracted from the main CLI for testability)
- The main CLI (`bin/modelrelay.js`) imports from `lib/utils.js`
- If you add new pure logic (calculations, parsing, filtering), add it to `lib/utils.js` and write tests
- If you modify existing logic in `lib/utils.js`, update the corresponding tests

### What's tested:
- **sources.js data integrity** — model structure, valid tiers, no duplicates, count consistency
- **Core logic** — getAvg, getVerdict, getUptime, sortResults, findBestModel
- **CLI arg parsing** — current router flags (`--port`, `--no-log`, `--ban`, `--onboard`)
- **Package sanity** — package.json fields, bin entry exists, shebang, ESM imports

## Sources Sync (free-coding-models Integration)

### Upstream Dependency

`free-coding-models-src/` is a git-cloned copy of [free-coding-models](https://github.com/vava-nessa/free-coding-models) (v0.3.25+) located at `../free-coding-models-src` relative to this project root. It provides the canonical upstream model definitions.

**Model array formats:**
- **modelrelay local**: `[modelId, label, ctx]` (3 fields)
- **free-coding-models upstream**: `[modelId, label, tier, sweScore, ctx]` (5 fields)
- **modelrelay `MODELS` export**: `[modelId, label, intell, ctx, providerKey]` (intell is a float 0-1 derived from scores.js)

### Sync Script

`node scripts/sync-sources.js` syncs model definitions from the upstream clone into local `sources.js`:

```bash
npm run sync:sources        # apply sync
npm run sync:sources:dry    # preview changes (dry run + verbose)
```

**What it does:**
- Reads `../free-coding-models-src/sources.js`
- For each shared provider (nvidia, groq, cerebras, etc.), compares upstream models with local
- Adds new models, updates label/ctx changes, preserves unchanged entries
- Skips CLI-only providers (rovo, gemini)
- Skips modelrelay-only providers (kilocode, openai-compatible, qwencode)
- Prints a diff summary (+added, ~updated)

**What it preserves:**
- Provider URLs (stable across upstream versions)
- Provider metadata (name, url)
- modelrelay-specific providers and their models
- MODEL_ID_ALIASES, MODEL_LABEL_OVERRIDES, resolveAliasedModelId, etc.
- scores.js (tier/sweScore handled separately)

**Manual post-sync steps:**
1. Update `scores.js` if new models need intelligence scores
2. Run `npm test` to verify
3. Commit the changes

