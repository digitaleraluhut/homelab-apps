# Development Plan: homelab-apps (fix/gh-actions-filtering-and-failures branch)

*Generated on 2026-05-24 by Vibe Feature MCP*
*Workflow: [bugfix](https://codemcp.github.io/workflows/workflows/bugfix)*

## Goal
Fix GitHub Actions workflows so that:
1. Each app's deploy workflow only triggers on its own relevant path changes (not on docs/vibe/markdown file changes or other apps' paths)
2. `deploy-matrix` and `deploy-lobehub` succeed (`npm ci` no longer fails)
3. `build-voice-transcription-bot` successfully authenticates to GHCR and pushes the image

## Key Decisions

### Decision 1: Exclude docs/vibe/markdown from deploy path filters
**Why**: The `fix(transcription-bot)` commit moved `apps/lobehub/.vibe/docs/architecture.md`, which matched `apps/lobehub/**` and spuriously triggered `deploy-lobehub`. Doc-only changes don't affect the running stack.
**How**: Added `paths-ignore`-style exclusions under the `paths:` array (negated glob patterns: `!apps/<app>/docs/**`, `!apps/<app>/.vibe/**`, `!apps/<app>/**/*.md`).
**Note**: GitHub Actions evaluates `paths` inclusions and exclusions together — a negated pattern in the `paths` list acts as an exclusion.

### Decision 2: Exclude voice-transcription-bot from deploy-matrix path filter
**Why**: Changes to `apps/matrix/voice-transcription-bot/**` (Python bot code) only affect the Docker image, not the Pulumi stack. The Pulumi stack reads `botImage` from `Pulumi.dev.yaml` config — only changes to that file (or other `apps/matrix/src/**`) should trigger a deploy. Bot code changes should trigger `build-voice-transcription-bot` only.
**How**: Added `- "!apps/matrix/voice-transcription-bot/**"` to deploy-matrix path filter.

### Decision 3: Fix GHCR auth — remove invalid `||` expression
**Why**: `secrets.GHCR_TOKEN || secrets.GITHUB_TOKEN` is not valid GitHub Actions expression syntax. `||` is a boolean OR — it does not fall back to the second secret if the first is missing. It evaluates to `true`/`false`, which is not a valid registry password.
**How**: Removed the `|| secrets.GITHUB_TOKEN` fallback entirely; now uses `secrets.GITHUB_TOKEN` directly. The workflow already has `permissions: packages: write`, so `GITHUB_TOKEN` has the necessary scope.

### Decision 5: Use `**/*.md` not `**.md` or `**\/*.md` for cross-depth .md exclusion
**Why**: `**.md` in minimatch (GHA's glob engine) only matches `.md` files at the root level. `**/*.md` correctly matches `.md` files at any depth including root (because `**` matches zero or more path components). This was verified against the actual `minimatch` library used by `@actions/glob`.
**How**: All 5 workflow files use `- "!**/*.md"` as the exclusion pattern.
**Verified**: 25-case simulation using `minimatch` with `{dot:true}` — all cases pass.

### Decision 6: Apply .md exclusion to all 5 workflows, not just the two initially fixed
**Why**: `build-voice-transcription-bot`, `build-sandbox-mcp`, and `deploy-aftertouch` had no `.md` exclusion — a README.md change in the bot dir would trigger a Docker image rebuild; a README.md change in aftertouch would trigger a deploy.
**How**: Added `- "!**/*.md"` to all 5 workflows. Also added explicit `docs/**` and `.vibe/**` exclusions to `deploy-aftertouch` which was missing them.

### Decision 7: Fix build-sandbox-mcp GHCR auth (same bug as voice-transcription-bot)
**Why**: `build-sandbox-mcp` had the same `secrets.GHCR_TOKEN || secrets.GITHUB_TOKEN` invalid expression bug. It was overlooked in the initial fix pass.
**How**: Replaced with `secrets.GITHUB_TOKEN` directly. `permissions: packages: write` already present.

### Decision 8: sandbox-mcp code changes correctly trigger both build-sandbox-mcp AND deploy-lobehub
**Why**: `apps/lobehub/sandbox-mcp/**` is a subdirectory of `apps/lobehub/**`, so a code change there correctly triggers: (1) `build-sandbox-mcp` to build the new image, and (2) `deploy-lobehub` to re-apply the Pulumi stack. This is the intended two-step flow (build → deploy picks up the new image tag after a manual config update).
**Decision**: No change needed here — the dual-trigger is correct by design.

### Decision 4: Regenerate package-lock.json
**Why**: `@homelab-apps/matrix` workspace was added to `apps/matrix/package.json` but `npm install` was never re-run at the repo root, so `package-lock.json` was missing the matrix workspace entry. `npm ci` (used in both deploy workflows via the reusable workflow) fails hard when the lockfile is out of sync.
**How**: Ran `npm install` at the repo root — this updated `package-lock.json` to include `@homelab-apps/matrix@0.1.0`.

### Decision 9: Squash-merge of fix branch correctly triggered zero CI runs
**Observation**: After squash-merging PR #9 to main (commit `c9d2c080`), no workflow runs were triggered. The commit only modified `.github/workflows/*.yml` and `package-lock.json` — none matching any app's `paths:` filter.
**Significance**: This confirms the path filters are working correctly end-to-end. CI-infrastructure-only changes don't spin up unnecessary deploy/build jobs.

## Notes
- The reusable workflow (`mrsimpson/homelab/.github/workflows/deploy-to-cluster.yml`) runs `npm ci` at the repo root using `npm-lock-file-path: package-lock.json`. Both `deploy-lobehub` and `deploy-matrix` share this root lockfile.
- `deploy-matrix` and `build-voice-transcription-bot` are intentionally separate: bot code push → image build only; `Pulumi.dev.yaml` update (with new image tag) → Pulumi deploy only.
- `GITHUB_TOKEN` with `permissions: packages: write` is sufficient to push to GHCR for org/user packages owned by the same repo owner — no separate PAT (`GHCR_TOKEN`) is needed.

## Reproduce
<!-- beads-phase-id: homelab-apps-4.1 -->
### Tasks
<!-- beads-synced: 2026-05-24 -->
*Auto-synced — do not edit here, use `bd` CLI instead.*


## Analyze
<!-- beads-phase-id: homelab-apps-4.2 -->
### Tasks
<!-- beads-synced: 2026-05-24 -->
*Auto-synced — do not edit here, use `bd` CLI instead.*


## Fix
<!-- beads-phase-id: homelab-apps-4.3 -->
### Tasks
<!-- beads-synced: 2026-05-24 -->
*Auto-synced — do not edit here, use `bd` CLI instead.*

- [x] `homelab-apps-4.3.1` Fix package-lock.json: add @homelab-apps/matrix workspace entry
- [x] `homelab-apps-4.3.2` Fix deploy-lobehub: exclude docs/vibe/markdown from path filter
- [x] `homelab-apps-4.3.3` Fix deploy-matrix: exclude docs/vibe/markdown and voice-transcription-bot from path filter
- [x] `homelab-apps-4.3.4` Fix build-voice-transcription-bot: use GITHUB_TOKEN directly (remove invalid || expression)

## Verify
<!-- beads-phase-id: homelab-apps-4.4 -->
### Tasks
<!-- beads-synced: 2026-05-24 -->
*Auto-synced — do not edit here, use `bd` CLI instead.*

- [x] `homelab-apps-4.4.1` Validate YAML syntax of all modified workflow files
- [x] `homelab-apps-4.4.2` Verify package-lock.json contains @homelab-apps/matrix entry
- [x] `homelab-apps-4.4.3` Verify path filter logic: negated globs work correctly in GHA paths:
- [x] `homelab-apps-4.4.4` Commit changes and push to branch
- [x] `homelab-apps-4.4.5` Observe CI run: confirm only expected workflows fire and pass
- [x] `homelab-apps-4.4.6` Fix md exclusions: use paths-ignore for all 5 workflows (including aftertouch, build-sandbox-mcp, build-voice-transcription-bot)
- [x] `homelab-apps-4.4.7` Fix build-sandbox-mcp: same invalid GHCR_TOKEN || GITHUB_TOKEN bug as voice-transcription-bot
- [x] `homelab-apps-4.4.8` Observe CI runs after squash-merge to main

## Finalize
<!-- beads-phase-id: homelab-apps-4.5 -->
### Tasks
<!-- beads-synced: 2026-05-24 -->
*Auto-synced — do not edit here, use `bd` CLI instead.*

