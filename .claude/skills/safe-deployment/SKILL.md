---
name: safe-deployment
description: Use for FanScope backend releases, database migrations, backups/restores, Docker release or rollback, Cloudflare Pages production checks, and any action that could change production data. Defines what is automatic, what needs explicit approval, and when to stop.
---

# FanScope Safe Deployment & Recovery

## Boundaries
| Action | Status |
| --- | --- |
| Cloudflare Pages production publish after green `main` CI | Automatic (approved). Still verify it. |
| PR previews | Automatic for frontend PRs to `main`; stacked/backend-only PRs skip by design |
| First real backend release (R0), every backend release | Needs explicit user approval each time |
| Applying migrations to an existing (production) database | Needs approval; only via K2 controller after frozen-copy rehearsal |
| Restore from backup, destructive data ops, secrets/permissions/branch protection changes | Needs approval |
| Paid model calls, sending real unpublished manuscripts to a model | Needs approval; synthetic data only otherwise |

## Database migrations (K3 contract, `api/src/migrations.mjs`, `docs/ops/MIGRATIONS_ZH.md`)
- Only additive SQL: new tables, ADD COLUMN (never on positional-INSERT tables), new indexes, fts5, INSERT into new tables. Every file is also effect-verified in its transaction.
- Startup on an **existing** DB is read-only: pending → `MIGRATIONS_PENDING`, edited file → `MIGRATION_CHECKSUM_MISMATCH`. Only a DB file the process just created gets the full schema.
- Apply explicitly: `npm run migrate -- status` then `apply --expect <id>:<sha256>` (exact reviewed list). Never edit an applied migration; add a new one.
- Every migration PR carries: legacy-fixture upgrade test, protected-column fingerprint unchanged, older code still starts on the migrated DB.
- The existing controller (`scripts/cicd/deploy_backend.py`) accepts only `migrationPolicy:'no-change'` and fails closed on any startup schema/data change; an image with pending migrations is rejected and rolled back. K2 adds the reviewed apply step — until then, no migration reaches production.

## Before any backend release
1. Exact `main` SHA has successful `push` CI; Docker rehearsal (`docker_rehearsal.py`) passed in that run.
2. Off-host backup exists and an isolated restore was verified (`scripts/cicd/sqlite_release.py backup` writes `verified.json`); record its path/hash.
3. Health baseline captured (`/api/health`, `/api/stats` counts) for comparison.
4. Paid workers off (`FANSCOPE_AI_AUTO_ENABLED=false`) unless separately approved.

## Release ordering
- `backend-release.yml` only ships the exact current `main`. Once a PR with migrations merges, the old controller cannot release anything, so a no-change release must happen before that merge.
- Keep paid features behind their own key (`FANSCOPE_DIAGNOSTIC_DEEPSEEK_API_KEY`) so `DEEPSEEK_API_KEY` stays empty and batch AI stays off.
- Rehearse upgrades with two real images: seed with the old image, migrate, then start both candidate and old image. Windows-only or Mock runs miss root-owned files and ledger state.

## "部署 FanScope 最新版"
Treat this sentence as a request to start a release, not as production approval. The human approval in the `production` environment stays with the user.
1. Needs `gh` logged in with Actions write. If it is missing, stop and give the web steps: Actions → FanScope backend release → Run workflow.
2. Read the current `main` SHA and require a successful `push` run of `FanScope checks` on that exact SHA. Never release a branch or an older SHA.
3. `gh workflow run backend-release.yml --ref main -f commit=<sha>`. Defaults match the server: `diagnostic_ai` and `scheduler` on.
4. Wait for the `build` job, then ask the user to approve the `production` environment. Say which SHA and whether it contains migrations.
5. After approval the host polls every minute. Check `/api/health`: `commit` must equal the SHA. Green Actions alone proves nothing. If `commit` does not change within 15 minutes, report it and ask for `journalctl -u fanscope-pull.service -n 50`.
A failed run needs a new `Run workflow`; the host ignores re-runs.

## Verify, don't assume
- Pages: `https://fanscope.pages.dev/release.json` commit == main SHA; `/`, `/lab/`, `/config.js`, `/app.js` return 200; API health ok.
- Backend: controller `result.json` status `success`, health `commit` == released SHA, `migrations` field matches the expected ledger.
- A green approval job in `backend-release.yml` means authorization only, not deployment.

## Stop and report immediately when
- Controller leaves maintenance mode on, `transaction.json` exists, or rollback failed — use `deploy_backend.py recover --confirm-sha`, never delete marker files by hand.
- Any fingerprint, integrity or foreign-key check fails, or counts drop.
- GitHub/Cloudflare returns 403/429/abuse warnings — stop automated writes.
Keep maintenance closed rather than "fixing forward" against production data.

## Rollback
- Frontend: Cloudflare dashboard "Rollback to this deployment" or `pages-deploy.yml` dispatch `rollback` with a verified deployment UUID.
- Backend: controller restores the verified frozen snapshot and previous image automatically on failed release. After a successful release with new writes, do not restore old snapshots over them; ship a reviewed revert instead.
