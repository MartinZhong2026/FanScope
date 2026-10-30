---
name: ci-resource-governance
description: Use for every FanScope task involving commits, pushes, pull requests, GitHub Actions, CI failures, Cloudflare Pages previews, or production releases. Minimize redundant GitHub work without weakening required gates.
---

# FanScope CI Resource Governance

## Objective
Ship reliable research-product changes with the smallest **necessary** GitHub Actions, Docker and browser workload. Preserve all security, compatibility, migration and production-release gates. This skill is a workflow instruction, not permission to merge, deploy, pay for services or modify production databases.

## Mandatory procedure before remote actions
1. Read `AGENTS.md`, `CLAUDE.md`, `.github/workflows/test.yml`, `.github/workflows/pages-deploy.yml`, and the current PR status when applicable.
2. Inspect `git status -sb`, `git diff --stat`, current branch/upstream, and existing PR/CI runs using read-only commands. Never push to `main` or force-push.
3. Determine change impact: documentation-only, web-only, API-only, database/migration, CI/CD trust-root, or mixed. Record the intended test scope.
4. Prefer local, targeted feedback first; then perform full local regression and necessary Docker/browser checks according to change risk. Use test fixtures and mocks; do not call paid models or production systems without explicit authorization.
5. **Batch related fixes into one logical push** after local testing. Do not push once per minor fix, create dummy/empty commits, open duplicate PRs, or trigger workflows merely to check whether GitHub is available.
6. Push to the existing task branch once ready; open or update **one** PR. For a stacked PR, explicitly record its base branch and downstream dependencies.
7. After push, inspect the actual run for the **exact current head SHA**. If it is queued or running, do not create redundant commits or reruns. Do not call a workflow "green" before required jobs complete successfully.
8. If CI fails, inspect failing step logs, reproduce/fix locally and only then push a substantive correction. If a transient infrastructure error is clear, a single justified failed-job rerun is acceptable; never loop reruns. Repeated same-root-cause failures require diagnosis, not further blind pushes.
9. Report test evidence, SHA, workflow IDs, and remaining blockers. Do not automatically merge, deploy backend, alter secrets, apply migrations, or operate on production without the applicable explicit authorization.

## Repository-specific pitfalls
- `test.yml` currently runs expensive Docker release/rollback rehearsal, full API tests, and Playwright Chromium/WebKit browser suites on **every PR update**, even for narrowly scoped changes. These are mandatory when risk requires them, but not every run needs every job.
- `pages-deploy.yml` subscribes to completed `FanScope checks` runs. **`workflow_run` always executes the workflow file and scripts from `main`**, so a fix to Pages gating only takes effect after it merges to `main`; patching it on a feature branch changes nothing.
- Implemented gating (keep it): stacked PRs (base not `main`) are filtered at job level (no runner); `scripts/cicd/pages-source.mjs` returns `mode=skip` (green, no deploy) for closed/superseded PRs, superseded main runs and PRs that touch no site files (`FRONTEND_PATHS`). Untrusted sources still fail. Do not trigger an extra preview to compensate for an intentional skip.
- This machine has no `gh` CLI and the GitHub MCP connector may fail: read run/PR state through the public REST API (unauthenticated GET), push via Git Credential Manager, and ask the user to open/ready/merge PRs. Job logs need auth (403); never extract tokens to get them.
- PR creation and pushing additional commits both cause `pull_request` workflows. Avoid opening unnecessary PRs or making one commit per attempted CI fix.
- Do not disable tests, required checks, security scanning, database migration rehearsals, rollback protections, branch protection, or production release gates just to reduce minutes.
- Cloudflare Pages production and backend deploy are different permissions. Frontend deployment may be automatic according to existing approved settings; first live backend release and real database migrations remain separately gated.
- The project is currently public; GitHub standard hosted runners for public repositories generally do not consume the private-repository included-minutes allocation. Workflow volume still consumes CI resources and creates operational noise, and artifacts may consume storage.

## Safe workflow optimization policy (code changes require dedicated PR)
1. First produce **evidence**: counts of runs by workflow/event/day, repeated runs per SHA, failed/skipped deployment jobs, approximate runner duration and artifact retention. Treat all numbers as observations, not proof of account abuse or enforcement.
2. Fix unnecessary stacked-PR preview attempts using a trustworthy early event/base validation. Preserve actual `main` production deployments and valid PR-to-`main` previews. Test cases: main push, PR to main, stacked PR, stale/closed PR, cancelled/failed source workflow, manual inspect/rollback. Verify that skip is a normal outcome, not reported as a deployment failure.
3. Consider change-aware test selection only after mapping risk; keep the `required` check predictable and effective. Do not use workflow-wide `paths` filters that leave branch-protection-required checks permanently pending. Maintain full critical coverage for changes to APIs, migrations, authentication, CI/CD, release code, and production-bound changes.
4. Preserve Cloudflare release identity invariants (`release.json`, current main SHA expectations) when considering documentation-only build or deploy skips. Do not skip a main production publish if doing so would break the deployment verification contract.
5. Reduce redundant artifact uploads and retention **only after** checking whether the Pages preview pipeline downloads those artifacts. The `mobile-app-experience` artifact is used for preview evidence; do not delete it blindly. Prefer explicitly bounded retention over default retention.
6. Prefer the repository's existing `concurrency` cancellation for superseded test runs; never cancel production deployment, user-approved release, or unrelated jobs to conserve minutes.
7. Change CI in a **single, small dedicated PR** with syntactic and behavioral tests, and confirm main/PR preview/release paths before and after merging. Do not introduce third-party Actions or extra infrastructure without clear benefit.

## Lessons recorded from real runs
- 2026-10-30: three `Stale/closed PR` failures (runs 40989863391, 40990777560, 40993138789) came from stacked PR #9 while its CI was green — an expected situation reported as a failure. Fixed by the gating above, verified against the real `pull_requests[0].base.ref` of those runs.
- A `required` failure next to `mobile: cancelled` usually means concurrency cancelled a superseded run; confirm with the newer SHA's run before diagnosing.
- When one dependent PR needs another (stacked), say so in both PR bodies and merge bottom-up; retarget the upper PR to `main` after the lower merges.

## Final report format
- Scope: which behaviors were optimized, which tests/releases remain intact.
- Evidence: before/after run counts, jobs, approximate runner-minutes or artifact retention when verifiable.
- Commits / PR / exact-SHA CI outcomes.
- Explicitly distinguish local tests, GitHub Actions and production deployment.
- Any missed coverage or changed approval behavior (must not be silent).
