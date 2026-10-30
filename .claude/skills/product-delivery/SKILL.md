---
name: product-delivery
description: Use when building or accepting a FanScope user-facing feature (Paper Diagnostic, literature intelligence, Research Copilot, Lab). Defines what "done" means, how to test real pages and AI quality, and how to keep infrastructure work from crowding out product value.
---

# FanScope Product Delivery & Quality

## Definition of done
A feature is delivered only when a real user can complete the task on the deployed site. Report these levels separately and never upgrade one into another:
1. Unit/API tests with mocks or contract fixtures.
2. Real-browser end-to-end on isolated fixtures (local + CI).
3. Real AI quality measured on synthetic data (approved paid run).
4. Deployed and verified in production with the feature flag on.

## Slicing
- Start from the user task; ship the smallest flow that completes it end to end behind a feature flag (default off), then deepen quality.
- Infrastructure (K2/K3/K5…) is done only to the extent the next product slice needs it. If a task grows a new framework, stop and pick the minimal path.
- New tables only through a versioned migration (see `safe-deployment`); no import-time `CREATE TABLE` in new modules.

## Browser end-to-end pattern
- Fixture server under `api/test/*-browser-server.mjs`: NEW database under `work/`, outbound `fetch` blocked, feature flags on, Pages `_headers` CSP applied. Driven by `scripts/*-browser-acceptance.py` (Playwright) and added to the CI `mobile` job.
- Check: real login, the full user flow, permission boundaries with a second account, a 390px viewport, no `pageerror`, no CSP violations, no external requests. Read the screenshots, not only the assertions.
- Locally, ports 4173/8787 may be busy with the user's own server; use the `DX_WEB_PORT`/`DX_API_PORT` overrides and stop only processes you started.
- Lesson: re-rendering before reading form state lost a checked consent box — read inputs before any state change that re-renders.

## AI quality
- Separate verifiable facts (verbatim quotes checked server-side against the source) from AI judgments; drop unverifiable quotes and count them.
- Measure with planted-flaw synthetic documents (`api/test/fixtures/dx-eval`, `scripts/dx-quality-eval.mjs`): recall of planted flaws, severity, fact-verification rate, type accuracy, tokens. Compare against the free rule baseline. Only after an approved paid run on GitHub-hosted runners (`dx-quality-eval.yml`), never from the user's Windows machine.
- Model calls: one place per provider, safe error codes, no retries loops, no text in logs; migrate to the unified LLM client (K4) before production.

## Privacy defaults for manuscripts and Lab data
- Server-side authorization through one function; tests for owner, shared user, trusted mentor, other members/mentors, admin and anonymous.
- Disclose who can see uploaded work at upload and consent time; record consent per engine.
- Retention enforced at read time and by idempotent purge; deletion immediate.
