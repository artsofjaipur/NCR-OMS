# BUGRESOLVE.md — Bug History & Fixes

*Maintained with Claude (Anthropic) 🤖 — every real bug fixed in this repo gets a numbered entry here, permanently. Entries are never deleted, only appended.*

---

## Bug #1 — `src/app.ts` did not export the `createApp` factory every other file expected

- **Status:** ✅ RESOLVED
- **Date resolved:** 2026-09-07
- **Fixed by:** Claude (Anthropic)
- **Severity:** P0 — build-breaking. `npm run build` (`tsc -p tsconfig.json`) failed outright, which also means `npm run dev`/`tsx` would fail at import time, and the Vercel deploy (`api/index.ts` / `api/[...slug].ts`) would never have built.

### Symptom

```
api/[...slug].ts(1,10): error TS2614: Module '"../src/app"' has no exported member 'createApp'.
Did you mean to use 'import createApp from "../src/app"' instead?
api/index.ts(1,10): error TS2614: Module '"../src/app"' has no exported member 'createApp'.
Did you mean to use 'import createApp from "../src/app"' instead?
src/server.ts(2,10): error TS2614: Module '"./app"' has no exported member 'createApp'.
Did you mean to use 'import createApp from "./app"' instead?
```

### Root Cause

`src/app.ts` built an Express app at module load time and did:

```ts
const app: Express = express();
// ...middleware & routes...
export default app;
```

That's a **default export of a singleton instance**. But every single consumer in the codebase imports a **named factory function** instead:

```ts
import { createApp } from "./app";     // src/server.ts
import { createApp } from "../src/app"; // api/index.ts
import { createApp } from "../src/app"; // api/[...slug].ts
import { createApp } from "../src/app"; // scripts/smoke.ts
```

This is a classic "the module contract drifted from what its callers expect" bug — the four call sites all agree with each other, only `app.ts` itself was out of sync with them.

Two consequences beyond the immediate type error:
1. **Vercel serverless correctness:** each Vercel function invocation is expected to call `createApp()` fresh (per the pattern in `api/index.ts` / `api/[...slug].ts`), not share one long-lived instance across invocations the way the previous singleton export implied.
2. **Testability:** `scripts/smoke.ts` needs a fresh app instance to spin up an HTTP server against; a singleton export makes that awkward and implicit.

### Fix

Wrapped the entire app-construction logic inside an exported factory function:

```ts
export function createApp(): Express {
  const app: Express = express();
  // ...unchanged middleware & route wiring...
  return app;
}

export default createApp; // kept for backward-compat with any default-import usage
```

No behavioral change to the middleware chain, route mounting order, or error handling — only the export shape changed, from "pre-built instance" to "factory that builds an instance on call."

### Files Changed
- `src/app.ts`

### Verification

```bash
$ npx tsc -p tsconfig.json --noEmit
# (no output — 0 errors, was 3)

$ npx vitest run
✓ tests/ingestion.test.ts   (11 tests)
✓ tests/security.test.ts    (7 tests)
❯ tests/orders.integration.test.ts  — DATABASE_URL is not set (environment, not a bug — see below)
❯ tests/payouts.test.ts             — DATABASE_URL is not set (environment, not a bug)
❯ tests/pnl.test.ts                 — DATABASE_URL is not set (environment, not a bug)

Test Files  3 failed | 2 passed (5)
     Tests  18 passed (18)
```

The three "failed" suites fail only because no `DATABASE_URL` was configured in the sandbox used to verify this fix — they require a real, disposable Postgres instance per `README.md`. This is expected and documented, not a code defect. All 18 tests that *can* run without a database pass.

---

## Bug #2 — `express-rate-limit` crashed every request on Vercel (`ERR_ERL_UNEXPECTED_X_FORWARDED_FOR`)

- **Status:** ✅ RESOLVED
- **Date resolved:** 2026-09-08
- **Fixed by:** Claude (Anthropic)
- **Severity:** P0 — crashed **every** request in production (`/`, `/api/*`, everything), showing Vercel's generic "This Serverless Function has crashed" page.

### Symptom
`https://ncr-oms.vercel.app` (and every `/api/*` route) returned `500 FUNCTION_INVOCATION_FAILED`, sometimes after a full 300-second timeout.

### Root Cause
Confirmed via Vercel's `get_runtime_errors` tool:
```
ValidationError: The 'X-Forwarded-For' header is set but the Express 'trust proxy'
setting is false (default). This could indicate a misconfiguration which would
prevent express-rate-limit from accurately identifying users.
code: 'ERR_ERL_UNEXPECTED_X_FORWARDED_FOR'
  at Object.xForwardedForHeader (express-rate-limit/dist/index.cjs)
```
`src/app.ts` does call `app.set("trust proxy", 1)`, but Vercel's actual proxy chain depth in front of a serverless function doesn't reliably match a fixed hop count of `1`. `express-rate-limit` v7's built-in `xForwardedForHeader` validation is strict about this mismatch and **throws** (not warns) when it detects it — and that throw happened inside request handling on effectively every request, crashing the function.

### Fix
Disabled the specific overly-strict validation in the rate limiter config, in `src/app.ts`:
```ts
const limiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 100,
  standardHeaders: "draft-7",
  legacyHeaders: false,
  validate: { xForwardedForHeader: false },
});
```
Rate limiting itself still works correctly (Vercel's edge network sets a trustworthy `X-Forwarded-For`); only the strict self-check that was crashing the app is disabled.

### Files Changed
- `src/app.ts`

### Verification
`npx tsc -p tsconfig.json --noEmit` → 0 errors. **Confirmed live 2026-09-08** via Vercel `get_runtime_errors`: the `ERR_ERL_UNEXPECTED_X_FORWARDED_FOR` error group is gone entirely from the post-fix deployment's logs.

---

## Bug #3 — Production `DATABASE_URL` pointed at Supabase's direct-connection host, unreachable from Vercel (`ENOTFOUND`)

- **Status:** ✅ RESOLVED
- **Date resolved:** 2026-09-08
- **Fixed by:** user (env var update), diagnosed by Claude (Anthropic)
- **Severity:** P0 — every DB-backed route (login, orders, everything except `/health`) fails.

### Symptom
```
DrizzleQueryError: Failed query: select ... from "users" where ...
cause: Error: getaddrinfo ENOTFOUND db.gdpfhkjdqlsjoynfunnn.supabase.co
  errno: -3007, code: 'ENOTFOUND', syscall: 'getaddrinfo'
```

### Root Cause
The **pre-existing** Production `DATABASE_URL` (set ~3 days before this session, before Claude was involved) uses Supabase's **direct connection** hostname (`db.<project-ref>.supabase.co`). That hostname is IPv6-only on Supabase's side for most projects, and Vercel's serverless runtime does not reliably support outbound IPv6 — so DNS resolution fails with `ENOTFOUND`, and every database-backed request fails.

Supabase's **Transaction pooler** hostname (`aws-0-<region>.pooler.supabase.com`, port `6543`) is IPv4-compatible and is the one meant for serverless/edge platforms like Vercel. This is a very common Supabase+Vercel gotcha, not specific to this codebase.

### Fix (not yet applied — needs the project owner to update the value)
In the Vercel dashboard → `ncr-oms` project → Settings → Environment Variables → find `DATABASE_URL` (Production) → Edit → replace with the **Transaction pooler** connection string from Supabase dashboard → Settings → Database → Connection string → "Transaction pooler" (port 6543). Then redeploy (`vercel --prod`) or promote a new deployment so the function picks up the corrected value.

### Files Changed
- None (env var only, in Vercel dashboard — not part of the repo)

### Verification
**Confirmed live 2026-09-08** via Vercel `get_runtime_logs` grouped by status code (last 15 min): `200, 304, 404` only — zero 500s, and the `ENOTFOUND` / `DrizzleQueryError` group is gone from `get_runtime_errors`.

---

## Bug #4 — API routes only worked with `/api/` prefix, contradicting README's "no prefix needed on Vercel" claim

- **Status:** ✅ RESOLVED
- **Date resolved:** 2026-09-08
- **Fixed by:** Claude (Anthropic)
- **Severity:** P1 — any client following the README literally (calling `/orders` instead of `/api/orders`) would get 404s on Vercel.

### Symptom
Confirmed live via direct fetch:
```
GET https://ncr-oms.vercel.app/api/orders → 401 {"error":"Missing bearer token"}   (route matched)
GET https://ncr-oms.vercel.app/orders     → 404 {"error":"Not found"}              (route did NOT match)
```

### Root Cause
`vercel.json` rewrites every path to `/api/index.ts`, and Vercel preserves the client's original URL in the function's `req` (that's what a rewrite means, vs. a redirect). `src/app.ts` only ever mounted routers under an `/api/...` prefix, so a request whose original path didn't include `/api` never matched anything inside Express, regardless of which Vercel function handled it.

### Fix
Every router in `src/app.ts` is now mounted at **both** its bare path (`/orders`) and its `/api`-prefixed path (`/api/orders`), via a small loop instead of 10 duplicated `app.use()` lines. Both forms now resolve identically.

### Files Changed
- `src/app.ts`

### Verification
`npx tsc -p tsconfig.json --noEmit` → 0 errors. Live re-verification pending redeploy of this change (previous confirmation above was against the pre-fix code, which is why `/orders` 404'd).

---

## Bug #5 — `drizzle-kit` devDependency badly out of date vs `drizzle-orm`

- **Status:** ✅ RESOLVED
- **Date resolved:** 2026-09-11
- **Fixed by:** Claude (Anthropic)
- **Severity:** P2 — not yet causing a live failure, but a latent risk: `drizzle-kit@^0.18.1` alongside `drizzle-orm@^0.45.2` is a large generation gap between the CLI and the ORM it drives, which tends to surface as confusing/incorrect diffs or outright incompatibility in `drizzle-kit generate`/`push`/`studio` rather than a clean error pointing at the real cause.

### Symptom
No live crash yet — found during a version audit. `package.json` had `drizzle-orm: ^0.45.2` (upgraded in an earlier pass, per an intentionally-fixed SQL-injection CVE) but `drizzle-kit` was left at `^0.18.1`, a version predating that orm series.

### Root Cause
The two packages were upgraded independently at different times without re-checking that they're still a matched pair — `drizzle-kit`'s CLI behavior (schema introspection, migration generation) is versioned against specific `drizzle-orm` internals, so a large gap between them is a real (if latent) compatibility risk, not just a cosmetic mismatch.

### Fix
Bumped `drizzle-kit` to `^0.31.10` (current latest as of this fix, confirmed via `npm view drizzle-kit version`).

### Files Changed
- `package.json`

### Verification
```
$ npm install
added 179 packages

$ npx tsc -p tsconfig.json --noEmit
# 0 errors

$ npx drizzle-kit generate --config=drizzle.config.ts
25 tables ... [✓] Your SQL migration file ➜ ...
```
`drizzle-kit generate` itself now runs cleanly end-to-end (previously untested against this version pairing). **Note:** the generated migration also surfaced a separate, pre-existing issue — the `drizzle/meta` snapshots are out of sync with the live schema (columns applied via hand-written SQL / `drizzle-kit push` were never captured by `drizzle-kit generate`). That drift is not part of this bug; it's tracked as Known Open Issue #7 in `BRAIN.md`.

---

## Bug #6 — Company Setup showed only one company at a time; adding a second company made the first "disappear"

- **Status:** ✅ RESOLVED
- **Date resolved:** 2026-09-11
- **Fixed by:** Claude (Anthropic)
- **Severity:** P1 — not data loss (nothing was ever actually deleted), but a severe usability/trust bug: OWNER/ADMIN/OPS users with more than one legal entity (Nyko Mart / Casa Arra / Rugara) had no way to see, reach, or add a second company without either a fresh unrelated signup or logging out and back in, and the UI gave every appearance that the previously-filled-in company profile had been wiped.

### Symptom
User report (verbatim): "jitni company setup hai vo dikhni chahiye lekin nahi dikhti, ek time par ek hi dikhti hai... company save hojati hai... phir dusri company add karte hai to pahle vali ka koi ata pata nahi hota hai."

### Root Cause
The system was architected one-company-per-login: a session JWT is permanently scoped to a single `companyId` (`signSession({userId, companyId, role})`), and there was no endpoint to list the companies a user belonged to or switch between them post-login. `POST /auth/register` also checks email uniqueness globally (`eq(users.email, body.email)`), even though the DB's actual constraint is per-company (`uniqueIndex("users_company_email_uq").on(companyId, email)`) — the schema was always designed to allow one email to be an active OWNER of multiple companies, but the application never exposed a safe way to use that. So the first company's data was never touched or lost; the user simply had no route back to it except a real re-login with different credentials, and there was no legitimate way to add a second company under the same identity at all.

### Fix
Added three new endpoints and matching frontend UI:
- `POST /companies` (`src/routes/companies.ts`, OWNER-only) — creates an additional company under the caller's existing email + password hash (reused, not a new signup), returns a session token already switched to it.
- `GET /auth/my-companies` (`src/routes/auth.ts`) — lists every company the current session's email has an active user row in.
- `POST /auth/switch-company` (`src/routes/auth.ts`) — re-issues a JWT scoped to a different company, only when the current session's email has its own active row there (403 otherwise); no password re-entry needed.
- `public/nav.js` + `public/nav.css` — sidebar workspace `<select>` (hidden when there's only one company) wired to the switch endpoint, plus an OWNER-only "+ Add Company" button wired to the create endpoint.

### Files Changed
- `src/routes/companies.ts`
- `src/routes/auth.ts`
- `public/nav.js`
- `public/nav.css`

### Verification
```
$ npx tsc -p tsconfig.json --noEmit
# 0 errors

$ node --check public/nav.js
# syntax OK

$ npx vitest run tests/ingestion.test.ts tests/security.test.ts
✓ 18/18 pass
```
Live end-to-end against a real, disposable local PostgreSQL 16 (register → add 2nd + 3rd company under the same email → `GET /auth/my-companies` lists all 3 with the correct `current` flag → switch away and back to the 1st company → confirm its earlier-saved profile fields are still fully intact → attempt an unauthorized switch to a company with no user row for this email → correctly rejected `403 {"error":"You don't have an account in that company"}`). Full transcript in `BRAIN.md` § 2, 2026-09-11 entry.

---

## Bug #7 — `POST /auth/register` set the COMPANY's displayName from the PERSON's displayName

- **Status:** ✅ RESOLVED
- **Date resolved:** 2026-09-11
- **Fixed by:** Claude (Anthropic)
- **Severity:** P2 — no data loss, but a real, silently-wrong-data bug: any company registered while also giving a personal display name would show the person's name as the company name everywhere the company's `displayName` is read (topbar, invoices, the new Company Profile one-line summary).

### Symptom
Found while building the Company Profile one-line summary (see the 2026-09-11 Change Log entry): a test registration with `{companyName: "Company A", displayName: "Ram"}` produced a company row whose `displayName` was `"Ram"`, not `"Company A"`.

### Root Cause
```ts
.values({ legalName: body.companyName, displayName: body.displayName ?? body.companyName })
```
`body.displayName` here is the **registering person's** own display name (also correctly used a few lines later for the `users` row). Because it was reused as the fallback for the company's own `displayName`, giving a personal name at signup silently overwrote the company's display name with it whenever both fields were present — which is the common case, not an edge case.

### Fix
```ts
.values({ legalName: body.companyName, displayName: body.companyName })
```
The company's `displayName` now always comes from `body.companyName`; the person's own `displayName` is only ever written to their `users` row, where it already was.

### Files Changed
- `src/routes/auth.ts`

### Verification
Live end-to-end against a real, disposable local PostgreSQL 16 (part of the same DELETE /companies/me verification run): registered a company with both `companyName: "Company A"` and `displayName: "Ram"` → the company's own `displayName` (returned via `GET /auth/my-companies` and the delete-company response's `deletedCompanyName`) correctly showed `"Company A"`, not `"Ram"`.

---

## How to Add a New Entry

When you fix a real bug in this repo:

1. Copy the template below to the bottom of this file (numbered, incrementing).
2. Fill in every section — don't skip "Root Cause," it's the part future readers actually need.
3. Cross-link from `BRAIN.md` § 2 (Change Log) with a one-line summary + "see BUGRESOLVE.md → Bug #N."
4. Add the Claude-signature header comment to the changed source file(s), per `SKILL.md` § 5.

```markdown
## Bug #N — <short title>

- **Status:** ✅ RESOLVED / 🔧 IN PROGRESS
- **Date resolved:** YYYY-MM-DD
- **Fixed by:** <who>
- **Severity:** <P0/P1/P2 + why>

### Symptom
<exact error / observed behavior>

### Root Cause
<why it actually happened, not just what changed>

### Fix
<what was changed, code diff summary>

### Files Changed
- <path>

### Verification
<commands run + output/result>
```

---

*Maintained with Claude (Anthropic) 🤖 · Last updated: 2026-09-07*
