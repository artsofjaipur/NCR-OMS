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
