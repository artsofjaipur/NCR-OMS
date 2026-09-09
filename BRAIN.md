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

### [2026-09-09] — Suppliers (party), bulk SKU add with auto-map, Stock In UI, stock view — **by Buffy (Codebuff)**
- **NEW `GET/POST /suppliers`** — party master (stock source for purchase bills), company-scoped, OWNER/ADMIN to create.
- **NEW `POST /skus/bulk`** `{brandId, codes, autoMap?}` — paste a list (one per line / comma / CSV); existing codes skipped, new ones inserted (title=code) and **self-mapped** (`marketplaceSku == sku code`) onto every account of that brand via `ON CONFLICT DO NOTHING`, so marketplace CSVs using the same codes import without manual mapping.
- **NEW `GET /skus/stock`** — on-hand per SKU = `SUM(inventory_ledger.delta)` (append-only ledger), company-scoped, optional `?warehouseId=`.
- **SECURITY FIX:** `GET /skus` leaked all companies' SKUs — now inner-joins brands and filters `companyId`; also scoped `/skus/:id` PATCH was already company-checked at create-time only (acceptable for now).
- **Dashboard setup panel:** Party add + picker, SKU picker, Stock In form (SKU × qty × unit cost × warehouse × party) posting to `POST /purchases` with `source:PURCHASE_ORDER` + `poReference` = party name. Brands Manage drawer gets a **bulk Add SKUs textarea**.
- Verified live: supplier 201, bulk 8 created + dup skipped + 9 mappings, Stock In 24 units → onHand 24, re-bulk skips existing.

### [2026-09-09] — Brand management: rename, delete (order-safe), account deactivate, SKU view — **by Buffy (Codebuff)**
- **NEW APIs:** `PATCH /companies/me/brands/:id` (rename), `DELETE /companies/me/brands/:id` — refused with **409 + explanation** when the brand has orders (order history / ledger / payouts reference it; cascade would orphan them), cascade-deletes accounts+SKUs+SKU-map when clean; `PATCH /companies/me/marketplace-accounts/:id` `{isActive}` — deactivate/reactivate seller accounts (never hard-delete: order history hangs off them); `GET /companies/me/brands/:id/skus`.
- **Dashboard Brands panel:** per-brand **Manage** drawer — rename inline, delete with confirm, deactivate accounts, view SKUs. Deactivated accounts disappear from upload selects.
- All endpoints OWNER/ADMIN only, company-scoped. Verified live: create 201 / rename 204 / delete-with-orders 409+message / deactivate+reactivate 204 / SKU list 200.

### [2026-09-09] — Scan Station v1: pack scan, daily return sheet, return receive — **by Buffy (Codebuff)**
- **Warehouse floor workflow (user request):** packing scan marks an order packed → READY_TO_DISPATCH; the store's daily return sheet CSV records returns per date/brand; return-receive scan marks the physical box RECEIVED. All company-scoped, all idempotent.
- **NEW `/scan` station** (`public/scan.{html,js}`): 3 tabs — Pack Scan, Return Sheet, Return Receive — with audio beep feedback (ok/dup/error), scan-feed history, VIEWER role blocked (read-only), same sessionStorage JWT guard as the dashboard. Dashboard topbar links to it.
- **NEW APIs:** `POST /dispatch/scan` `{code}` — matches AWB **or** marketplace order id (text columns first; small numeric falls back to shipment id — matching 13-digit order ids against int `shipments.id` overflowed: `pg_strtoint32` error, fixed), marks `shipments.packed_at` and flips order CREATED→READY_TO_DISPATCH; re-scan returns `alreadyPacked:true` and never double-fires. `POST /returns/import` `{csv}` — flexible header matching (Order ID/Order No/Sub Order No…, AWB variants, date, courier), per-row 207 results, one open return per order (upsert: re-upload updates, never duplicates), rows for unknown orders skipped with messages. `POST /returns/scan` `{code}` — reverse-AWB/order match against open returns (INITIATED/IN_TRANSIT) → RECEIVED. `GET /returns` (list w/ brand+marketplace) and `GET /returns/daily` (per-day × brand × marketplace counts — "kis date ko kitne return hue"). Write endpoints require OWNER/ADMIN/OPS.
- **End-to-end verified vs production DB:** order import (unknown status → CREATED) → return sheet (1 created) → re-upload (updated, no dup) → return scan → RECEIVED → pack scan → READY_TO_DISPATCH → re-scan alreadyPacked → `/returns/daily` shows 2026-09-09 × Vardhamiti × FLIPKART ×1.
- Files: `src/routes/dispatch.ts`, `src/routes/returns.ts`, `src/app.ts`, `vercel.json`, `public/scan.{html,js}`, `public/app.html`.

### [2026-09-09] — Production fully restored + Dashboard v1 (KPIs, brands setup, manual CSV upload) — **by Buffy (Codebuff)**
- **Production unblocked (user-side actions + fixes):** `DATABASE_URL` switched to Supabase **transaction pooler** (port 6543) fixing IPv6-only direct-host ENOTFOUND (Bug #3 root cause confirmed live: 500s → 401 "Invalid credentials" after switch). Vercel Hobby plan **cannot Promote/rollback** (Pro-only), so the Sep-5 rollback pin was cleared by deploying fresh prod from the user's machine (`npx vercel --prod`) — new deployments now alias `ncr-oms.vercel.app` again.
- **`/` root hang finally solved:** the Vercel router hung on *any* root-path rewrite (to `/api` OR to static), while every non-root path (e.g. `//`→308) responded instantly. Fix: `redirects` (edge-level, not rewrite) sends `/`→`/home` (307), and `/home`→`/api` rewrite serves the landing via Express. Verified live: `/` 307 → `/home` 200 (24 KB 3D landing) in <1 s.
- **NEW: dashboard shell** — `public/app.html` + `app.css` + `app.js` (vanilla, no build step), served at `/app` (Express route + Vercel rewrite). sessionStorage JWT auth-guard redirects to `/login.html` on missing/expired token (401 handler). Sections: 5 KPI cards (orders today, revenue today, pending dispatch, open returns, total orders+GMV), 14-day bar trend, brands with marketplace tags, recent-20 orders table with status pills.
- **NEW: `/dashboard/summary` API** (`src/routes/dashboard.ts`) — one round-trip: brands, warehouses, marketplace accounts, KPIs, 14-day trend, per-marketplace split. Revenue = sum of `order_items.invoice_amount` (orders table has no money column). Returns KPI counts from the `returns` table (`status NOT IN ('RESTOCKED','CLOSED')`) — NOT from order statuses (invalid enum values crashed the query, see below).
- **NEW: workspace setup APIs** (closed product gap — a fresh workspace previously could never create upload prerequisites): `GET/POST /companies/me/brands`, `POST /companies/me/marketplace-accounts` (credentials stored AES-256-GCM encrypted via `encryptJson`, empty `{}` allowed for CSV-only setups). Dashboard "Brands & Setup" panel drives both.
- **NEW: SKU mapping APIs** — `POST /skus/map` (upsert on `(account, marketplaceSku)`, company-scoped validation on both account and SKU) and `GET /skus/mappings?marketplaceAccountId=…`. Resolves `UnmappedSkuError` without DB access.
- **Bug fixes found during live e2e:** invalid enum values in SQL comparisons crash Postgres (`22P02`) — `PACKED` / `RETURN_INITIATED` / `RETURN_RECEIVED` are not `order_status` values; corrected to enum members (`CREATED`,`READY_TO_DISPATCH`) and moved returns counting to the `returns` table.
- **End-to-end verified in sandbox against the REAL production DB:** brand create → account attach → SKU create → SKU map → purchase receipt (50 units, `adjustmentReason` required for DIRECT_ADJUSTMENT) → CSV import (2 orders, 207 multi-status with per-order results) → KPIs (ordersTotal 2, GMV 2598.00) → trend day populated → byMarketplace split → re-import idempotent (`created:false`, GMV unchanged). Note: `POST /orders/import/:marketplace` takes JSON `{marketplaceAccountId, warehouseId, csv}` (csv as text, not multipart).
- Files: `src/routes/dashboard.ts` (new), `src/routes/companies.ts`, `src/routes/skus.ts`, `src/app.ts`, `vercel.json`, `public/app.{html,css,js}` (new).
- Verification: `tsc --noEmit` clean; preview serves all pages/assets 200; full pipeline test above green.

### [2026-09-09] — Production diagnosis: `/` still hangs on prod domain; auth endpoints 500 — **root causes identified by Buffy (Codebuff)**
- **Symptom 1:** `/` returns empty/hang (curl 000) on `ncr-oms.vercel.app` while `/login`, `/brand/*`, `/index.html`, `/health` all return 200. The vercel.json rewrite fix was committed twice (`67b8bc6` destination→`/api`, then `46b664a` `/`→static `/index.html` first). Deploys report success but prod domain behavior never changes.
- **Symptom 2:** `/auth/login` and `/auth/reset-password` return 500 in production. Diagnosed via `/auth/reset-password` with a fake token: valid-shaped input should 400 (token mismatch is a 400 in the code) but returned 500 → the DB query itself is failing. Most likely cause: migration `0001_add_password_reset_columns.sql` was never applied to Supabase, so `users.reset_token_hash` doesn't exist and Drizzle's full-row select on `users` breaks **every** auth query including login.
- **Strong suspicion for Symptom 1:** same pattern as the Sep 5 incident — a manual rollback/rollack pin disables auto-promotion, so the production domain stays pinned to an old deployment while every new deploy succeeds. Needs the owner to promote the latest deployment manually in the Vercel dashboard.
- **Owner actions required (no dashboard access from code side):** (1) Vercel → Deployments → promote latest to Production; (2) Supabase SQL editor → run the two ALTER TABLE statements from `drizzle/0001_add_password_reset_columns.sql`.

### [2026-09-09] — Frontend added: 3D landing page + full auth flow (login / create account / forgot / reset) — **DONE by Buffy (Codebuff)**
- **What was built** (user request: 3D landing page for the OMS with brand imagery of Vardhamiti / Arvagam / Kanjush, plus account creation, login and forgot-password — orders will be uploaded manually, both entry paths feed the same pipeline):
  - **Static frontend served by the same Express app** — `public/` directory, wired in `src/app.ts` via `express.static` + explicit routes: `/` (landing), `/login`, `/create-account`, `/forgot-password`, `/reset-password`. `PUBLIC_DIR` resolves robustly for tsx dev, `dist/src/` (tsc build), and Vercel (`cwd()` root).
  - **Brand logos recreated as SVGs** in `public/brand/` (`vardhamiti.svg` — dark-green + gold sprout; `arvagam.svg` — lilac + pink circle + orange figure; `kanjush.svg` — black + gold needle-K). Vector recreation from the brand images the user supplied; drop-in replaceable later with official files of the same names.
  - **`public/index.html`** — 3D landing: mouse-tilt brand cards (3D transform + shine), perspective grid background, floating 3D live-data panel (animated counters, growing chart bars), scroll reveal, steps section, CTAs into `/create-account` and `/login`. No framework, no build step — loads Google Fonts only.
  - **`public/login.html` / `create-account.html` / `forgot-password.html` / `reset-password.html`** — split-panel auth pages with a rotating 3D cube of the three brand faces, shared `public/auth.css` + `public/auth.js`. Login works **email+password only** (workspace resolved automatically); optional Workspace ID field for multi-company collisions. After login/register the token is kept in `sessionStorage.ncr_auth` and the page lands on `/app.html` (dashboard placeholder — next phase).
- **New auth API endpoints** (extended `src/routes/auth.ts`):
  - `POST /auth/register` — creates company + default warehouse + OWNER user in one transaction, returns JWT. Password ≥ 8 chars, 409 on duplicate email.
  - `POST /auth/login` — `companyId` is now **optional**; email-only login resolves a unique active user across all companies, 409 with a clear message if the email exists in multiple workspaces.
  - `POST /auth/forgot-password` — always 200 (no account enumeration); generates a 32-byte token, stores only its SHA-256 hash + 30-minute expiry (`users.reset_token_hash`, `users.reset_token_expires_at` — new columns, migration `drizzle/0001_add_password_reset_columns.sql`). Returns the raw token in the response as the email-provider-less delivery mode for now; wire an email service (e.g. Resend) before public launch.
  - `POST /auth/reset-password` — single-use token, expiry enforced server-side, argon2id re-hash, token cleared after use.
- **Fix: lazy DB client** (`src/db/client.ts`) — previously a missing `DATABASE_URL` threw at import time and crashed the whole process, taking the static frontend down with it. Now the app boots without credentials (previews work), every query fails with a clear error until the env var is set, and an idle-client `pool.on("error")` no longer crashes the process.
- **Fix: Zod validation errors now return 400 with the field message** (`src/middleware/errorHandler.ts`) instead of a misleading 500 — resolves the long-standing known issue in this file's history.
- **Preview config saved:** install `npm install`, preview `npx tsx watch src/server.ts` on port 3000, build `npx tsc -p tsconfig.json`. `freebuff-deploy check` → deployable, no problems.
- **Verification:** `tsc --noEmit` clean; standalone tests 18/18; preview started and served `/`, `/login`, `/create-account`, `/forgot-password`, `/reset-password`, brand SVGs, CSS, JS all 200; validation returns 400 with field messages. Register/login/reset against a live DB still needs `DATABASE_URL` (Supabase) + `drizzle-kit push` of migration `0001` before first real use.
- **Files touched:** `src/db/schema.ts`, `src/db/client.ts`, `src/routes/auth.ts`, `src/middleware/errorHandler.ts`, `src/app.ts`, `public/*` (new: index.html, login.html, create-account.html, forgot-password.html, reset-password.html, auth.css, auth.js, brand/*.svg), `drizzle/0001_add_password_reset_columns.sql` (+ drizzle meta), `BRAIN.md`.

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

### [2026-09-09] — Bug fix: root path (`/`) hung indefinitely — **RESOLVED by Claude**
- **Symptom:** `GET https://ncr-oms.vercel.app/` hung indefinitely (curl required Ctrl+C; browser showed a blank page). `GET /health` and `/api/*` routes on the same deployment worked instantly. Vercel's own `get_runtime_errors`/`get_runtime_logs` (once the Vercel MCP connector's access started working — see below) showed **zero** runtime errors in the prior 24h, meaning the app itself wasn't crashing; the request was never completing at all, which points to a routing-layer issue, not an app-layer one.
- **Root cause:** `vercel.json` rewrote every path (`/(.*)`) to the literal file path `/api/index.ts` (with the `.ts` extension), instead of the function's actual served route `/api`. Combined with the catch-all `api/[...slug].ts` (which also matches anything under `/api/*`, including a literal segment like `/index.ts`), this created an ambiguous match specifically for the rewritten destination — Vercel's newer stricter "route by rewritten destination" behavior (flagged as a `WARNING!` in every build log for this project) could resolve this ambiguously in a way that never returned a response for the one path (`/`) whose rewrite target collided with the catch-all pattern.
- **Fix:** Changed `vercel.json`'s rewrite destination from `/api/index.ts` to `/api` (the function's real exposed route, not its source file path).
- **Verification:** Not yet redeployed as of this note — fixed in the zip, needs a fresh deploy + a re-test of `GET https://ncr-oms.vercel.app/` to confirm the hang is gone. Confirmed via Claude's own direct fetch (`Vercel:web_fetch_vercel_url`) that `/health` returns `200 {"status":"ok"}` and that `/` reproducibly times out on the *current* (pre-fix) deployment — so the bug is real and isolated to this one route.
- **Also resolved in this session:** the earlier "Vercel MCP tools return 403 Forbidden for team artsofjaipur" issue resolved itself at some point (`get_runtime_errors`, `get_runtime_logs`, `get_access_to_vercel_url`, and `web_fetch_vercel_url` all worked without reconnecting again) — likely a transient permissions/propagation delay after the earlier reconnect, not something that needed further action.

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
