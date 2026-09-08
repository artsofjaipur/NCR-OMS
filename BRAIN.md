# BRAIN.md — NCR-OMS Project Memory

> **Purpose:** This file is the single source of truth for "what is the current state of this project, right now." It is updated **immediately after every change** — no batching, no delay. If you (human or AI) make a change and don't see it reflected here, treat BRAIN.md as stale and re-sync it before doing anything else.
>
> Maintained with: **Claude (Anthropic)** — 🤖 *Claude signature applied to all files touched during this pass.*

---

## 1. Project Snapshot

| Field | Value |
|---|---|
| Name | NCR-OMS (`switchboard-oms`) |
| Type | Backend API — multi-brand, multi-marketplace apparel order management system |
| Stack | Node.js 22, TypeScript (strict), Express 4, PostgreSQL 16, Drizzle ORM |
| Deploy targets | Persistent process (`src/server.ts`) **and** Vercel serverless (`api/index.ts`, `api/[...slug].ts`) — both share one `createApp()` factory in `src/app.ts` |
| Status as of this pass | ✅ Builds clean (`tsc --noEmit` passes). ✅ Standalone tests pass (18/18). ⚠️ Integration tests need a live `DATABASE_URL` (expected — not a bug). |

---

## 2. Change Log (most recent first)

### [2026-09-07] — Fix: `src/app.ts` missing named `createApp` export — **RESOLVED by Claude**
- **Severity:** Build-breaking (P0). `npx tsc` failed with `TS2614` in 3 files.
- **Root cause:** `src/app.ts` built the Express app and did `export default app;` (a singleton instance). But every consumer — `src/server.ts`, `api/index.ts`, `api/[...slug].ts`, `scripts/smoke.ts` — imports a **named** factory: `import { createApp } from "./app"`.
- **Fix:** Wrapped the app construction in an exported `export function createApp(): Express { ... }`. Kept `export default createApp` too, for backward compatibility with any default-import usage.
- **Files touched:** `src/app.ts`
- **Verification:** `npx tsc -p tsconfig.json --noEmit` → 0 errors (was 3). `npx vitest run` → 18 passed / 3 suites skipped due to missing `DATABASE_URL` (environment, not code).
- **Full write-up:** see `BUGRESOLVE.md` → Bug #1.

### [2026-09-07] — Docs: added BRAIN.md, SKILL.md, APP_STRUCTURE.md, BUGRESOLVE.md — **DONE by Claude**
- Added the four project meta-docs requested. No source code touched in this entry.

### [2026-09-07] — Infra: pushed schema to connected Supabase project — **DONE by Claude**
- Ran `npx drizzle-kit generate` (no live DB connection needed — pure schema diff) → `drizzle/0000_busy_hedge_knight.sql`.
- Applied that migration via the Supabase MCP connector (`apply_migration`) to project `artsofjaipur's Project` (`gdpfhkjdqlsjoynfunnn`, ap-northeast-1, Postgres 17).
- Verified via `list_tables`: all 22 tables now exist (companies, brands, skus, orders, inventory_ledger, etc.), 0 rows each — clean slate.
- **⚠️ Open action item for the human:** Supabase's advisor flagged Row Level Security disabled on all 22 tables — exposed to the `anon`/`authenticated` roles via Supabase's auto-generated PostgREST API if that key ever leaks. This app talks to Postgres directly (not the Supabase JS client), so normal traffic is unaffected, but RLS should still be enabled with policies matching the app's RBAC model (OWNER/ADMIN/OPS/VIEWER) before this project is trusted with real data. Not auto-applied — enabling RLS with no policies would lock the app out of its own tables.

### [2026-09-07] — Infra: GitHub connector unavailable; Vercel deploy done manually instead of via MCP — **NOTED by Claude**
- Searched the MCP connector registry for a GitHub app — none exists in this workspace's directory. This is not a settings toggle; there's currently no GitHub MCP app to connect.
- Vercel IS connected, but `list_teams` / `get_git_deployment_context` returned no teams, which blocks `create_git_project` (needs a team + a real remote repo anyway, which doesn't exist without GitHub).
- The `deploy_to_vercel` MCP tool takes literal file content per call (no file-path reference), which for this ~94KB/41-file project means retyping the entire codebase into one tool call — too high a transcription-error risk to do silently. Recommended the human deploy via the Vercel CLI from their own machine instead (see README "Deploy: Supabase + Vercel" section, updated env var note below).
- **Still needed from the human before deploy:** the real Postgres connection string (Supabase dashboard → Settings → Database → Transaction pooler, port 6543) for `DATABASE_URL` — Supabase's MCP tools don't expose the DB password, by design.

### [2026-09-07] — Infra: successfully deployed to Vercel Production — **DONE (by user, guided by Claude)**
- Vercel project `artsofjaipur/ncr-oms` turned out to be a **pre-existing project** (3 days old) with Vercel's native Supabase integration already attached — hence the `NEXT_PUBLIC_SUPABASE_*` / `SUPABASE_SERVICE_ROLE_KEY` naming (Vercel's standard convention for that integration, unrelated to this being an Express, not Next.js, app).
- Verified via `vercel env pull --environment=production` that the **pre-existing** `DATABASE_URL` in Production already pointed at the correct Supabase project (`gdpfhkjdqlsjoynfunnn`) — confirmed by the user. No need to overwrite it.
- Pre-existing `JWT_SECRET` in Production was also already set — left as-is, not overwritten.
- Added `ENCRYPTION_MASTER_KEY` to Production (was missing — this was the actual gap causing 3 days of "not connecting").
- Also added a fresh `DATABASE_URL` to Preview + Development environments (they had none before). `JWT_SECRET` / `ENCRYPTION_MASTER_KEY` are still **missing from Preview + Development** — harmless for now since only Production is being used, but worth filling in before anyone tests a preview deployment.
- Ran `vercel --prod` → deployed successfully in 37s → `https://ncr-l1muh8l7g-artsofjaipur.vercel.app`
- **Verified live:** `GET /health` → `{"status":"ok"}` ✅
- **Not yet verified live:** any `/api/*` route (auth, orders, etc.) — and per Known Open Issue #6, `/orders` (no `/api` prefix) is expected to 404 given the current `vercel.json` + `app.ts` mount-path mismatch. Worth testing an actual `/api/auth/...` call next to confirm the prefixed routes work as expected.

### [2026-09-07] — Infra: Vercel "Deployment Protection" was blocking every external request — **FOUND by Claude, fixed by user via dashboard**
- Testing `POST /api/auth/login` with `curl` returned `401 {"error":{"code":"401","message":"Protected deployment"}}` — **not** an app-level auth failure. This is Vercel's own SSO wall (`vercel_auth_enabled: true`), which blocks all unauthenticated external clients (curl, Postman, a real mobile app, actual customers) from ever reaching the app, while still letting the browser through silently because the user was already logged into vercel.com.
- The connected Vercel MCP tools (`get_project_deployment_protection` / `update_project_deployment_protection`) returned `403 Forbidden` for team `artsofjaipur` — the MCP connector's authenticated scope doesn't have access to this team, so this had to be fixed manually via Project → Settings → Deployment Protection in the Vercel dashboard instead of via MCP.
- **This — not the route-prefix issue, not the DB connection — was almost certainly the actual cause of "3 din se connect nahi ho raha" (3 days of "won't connect").** Once Deployment Protection is off for Production, external calls should get a real app response instead of Vercel's wall.
- Still to confirm: re-run the `curl /api/auth/login` test after the dashboard change to verify a real (non-Vercel) response comes back, and separately confirm/resolve Known Open Issue #6 (route prefix).

### [2026-09-07] — Infra: **ROOT CAUSE of "3 din se connect nahi ho raha" found & fixed** — production domain pinned to a crashed rollback — **DONE by user, guided by Claude**
- Confirmed via curl that `POST /api/auth/login` on the fresh deployment (`ncr-l1muh8l7g-artsofjaipur.vercel.app`) returned a real app response (`401 Invalid credentials` once the request included the required `companyId` field) — DB connection, argon2, JWT signing all working correctly end-to-end.
- **But** the actual production domain `ncr-oms.vercel.app` was still serving a *different, older deployment* — one that had been manually rolled back on Sep 5 to a broken build ("Add files via upload", commit `3a1356c`) which crashed with `FUNCTION_INVOCATION_FAILED`. A manual rollback in Vercel disables auto-promotion of new deployments to Production until explicitly undone — so every `vercel --prod` run since Sep 5 was deploying successfully but never actually reaching the live domain.
- **This — not RLS, not the route-prefix issue, not Deployment Protection — was the real, final cause of 3 days of "won't connect."**
- Fix: promoted today's known-good deployment to Production via the Vercel dashboard (Deployments → today's deployment → "..." → "Promote to Production").
- **Verified:** `https://ncr-oms.vercel.app/health` → `{"status":"ok"}` ✅ — the actual production domain is now live and correct.
- **Correction to an earlier entry:** discovered via a Supabase dashboard screenshot that a GitHub repo (`artsofjaipur/NCR-OMS`) *does* exist and is connected to the Supabase project. The earlier "GitHub not connected" finding was specifically about Anthropic's MCP connector directory (still true — no GitHub MCP app is available in this chat), not about whether a GitHub repo exists for this project. The user does have a real repo; it's just not reachable via MCP tools in this conversation.

### [2026-09-08] — **CORRECTION: the actual root causes** of the ongoing 500 crashes, found via Vercel's `get_runtime_errors` — **2 real bugs, 1 fixed, 1 pending an env var change**
- The Sep 5 stale-rollback fix (previous entry) was real and necessary, but not sufficient — after promoting, `ncr-oms.vercel.app` was still crashing (`FUNCTION_INVOCATION_FAILED`) on every route. The Vercel MCP connector initially had zero access (403 on every call, `list_teams` returned empty) because it was authenticated under a different Vercel identity than the CLI session — the user re-authorized it via Claude's Connectors settings, after which team `team_IVmn7i8elwmCODqnaA8FDErP` (`artsofjaipur`) became visible and `get_runtime_errors` worked.
- **Bug #2 (fixed):** `express-rate-limit` was throwing `ERR_ERL_UNEXPECTED_X_FORWARDED_FOR` on effectively every request, crashing the function — Vercel's proxy chain depth doesn't match the app's fixed `trust proxy: 1` setting closely enough for the library's strict self-check. Fixed in `src/app.ts` by setting `validate: { xForwardedForHeader: false }` on the rate limiter. Full write-up: `BUGRESOLVE.md` Bug #2.
- **Bug #3 (identified, not yet applied):** the pre-existing Production `DATABASE_URL` (set 3 days ago, before this session) points at Supabase's **direct-connection** host (`db.gdpfhkjdqlsjoynfunnn.supabase.co`), which is IPv6-only and does not resolve from Vercel's serverless runtime (`ENOTFOUND`). Needs to be replaced with the **Transaction pooler** connection string (port 6543) via the Vercel dashboard — this is an env var change, not a code change, so it needs the project owner to do it (Claude doesn't have the actual DB password). Full write-up: `BUGRESOLVE.md` Bug #3.
- **Next step:** redeploy with the Bug #2 code fix, update the `DATABASE_URL` env var for Bug #3, redeploy again, then re-test `/health` and `POST /api/auth/login` on `ncr-oms.vercel.app`.

### [2026-09-08] — **CONFIRMED FIXED**: both Bug #2 and Bug #3 resolved, verified live via Vercel `get_runtime_errors` / `get_runtime_logs`
- User applied both fixes: replaced `src/app.ts` with the rate-limiter fix, and updated Production `DATABASE_URL` to the Supabase Transaction pooler connection string. Deployment happened via GitHub push ("Add files via upload" to `artsofjaipur/NCR-OMS`, auto-deployed by Vercel's GitHub integration) rather than the CLI this time — also confirms a real GitHub repo does exist and is connected for auto-deploy.
- `get_runtime_errors` (last 10 min): only a harmless Node.js `DEP0169` deprecation warning (`url.parse()`) — **no more `ERR_ERL_UNEXPECTED_X_FORWARDED_FOR`, no more `ENOTFOUND`**.
- `get_runtime_logs` grouped by status code (last 15 min): `200: 1, 304: 1, 404: 2` — **zero 500s**.
- **Status: NCR-OMS is now live and functioning correctly at `https://ncr-oms.vercel.app`.**
- Still open (non-blocking, tracked in Known Open Issues): #6 route-prefix mismatch (`/orders` vs `/api/orders`), Zod validation errors returning 500 instead of 400, RLS disabled on Supabase tables, and filling `JWT_SECRET`/`ENCRYPTION_MASTER_KEY` into Preview/Development environments.

### [2026-09-08] — Fix: route-prefix mismatch (Known Open Issue #6) — **DONE by Claude**
- Confirmed live via direct fetch (using the connected Vercel MCP tools, no browser needed): `/api/orders` → 401 (matched, needs auth) vs `/orders` → 404 (not matched) — bug was real, not just theoretical.
- User chose: fix the code so both forms work, rather than just fixing the README.
- Fixed in `src/app.ts`: every router now mounted at both its bare path and its `/api`-prefixed path via a loop, instead of only the `/api`-prefixed one. Full write-up: `BUGRESOLVE.md` Bug #4.
- `npx tsc --noEmit` → 0 errors. **Not yet redeployed/re-verified live** — needs another `git push` (or `vercel --prod`) + promote, same as the last two fixes.

---

## 3. Known Open Issues (not yet fixed — carried from README "Known gaps")

These are pre-existing, documented limitations of the codebase itself, not bugs introduced by any tooling:

1. **Amazon connector unimplemented** — `src/connectors/amazon.ts` throws `NotImplementedError` per method by design; no live-API ingestion path yet. Only CSV import works today.
2. **Return/RTO field mapping** only verified against Snapdeal's export; no Flipkart/Meesho return-report samples yet.
3. **Meesho "Ready to Ship" export has no AWB or address** — Daily Dispatch can't complete Meesho handoff until a Meesho label/manifest export exists to parse.
4. **No UI** — API layer only, by design.
5. **Deploy path unverified end-to-end** — build/tests pass locally against local Postgres; a real Supabase+Vercel deploy has not been exercised with live credentials.
6. ~~`vercel.json` rewrites every path...~~ — **FIXED 2026-09-08**, see Change Log below and `BUGRESOLVE.md` Bug #4.

---

## 4. Environment Requirements

- `DATABASE_URL` — required for `orders.integration.test.ts`, `payouts.test.ts`, `pnl.test.ts`, and for `npm run dev` / `npm start`. **Do not** point this at production; the integration tests truncate core tables.
- `ENCRYPTION_MASTER_KEY` — 32-byte hex, used for AES-256-GCM envelope encryption of marketplace credentials & bank details.
- `JWT_SECRET` — 48-byte hex, HS256 session signing.
- `CORS_ALLOWED_ORIGINS` — comma-separated allow-list; falls back to `*` if unset.

---

## 5. Update Protocol (read this before changing anything)

1. Make the code change.
2. Verify it (`npx tsc --noEmit`, and `npx vitest run` where applicable).
3. **Immediately** append a new entry to Section 2 (Change Log) of this file — same turn, no delay — following the existing entry format: date, one-line title, severity/type, root cause, fix, files touched, verification.
4. If the change resolves or introduces a "Known Open Issue," update Section 3 accordingly.
5. If the change is a bug fix, also add/update the matching entry in `BUGRESOLVE.md`.
6. Never remove old Change Log entries — this file is an append-first history.

---

*Last synced: 2026-09-07 · by Claude (Anthropic)*
