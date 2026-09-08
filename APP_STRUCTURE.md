# APP_STRUCTURE.md — NCR-OMS Architecture Map

*Maintained with Claude (Anthropic) 🤖 — regenerate/update this file whenever the module layout changes.*

---

## 1. High-Level Shape

NCR-OMS is a single Express API that runs two ways from **one shared app factory**:

```
                     ┌───────────────────────┐
                     │   src/app.ts           │
                     │   createApp(): Express │◄──────────────┐
                     └──────────┬─────────────┘                │
                                │                                │
             ┌──────────────────┴──────────────────┐            │
             ▼                                      ▼            │
   src/server.ts (long-running process)   api/index.ts + api/[...slug].ts
   npm run dev / npm start                  (Vercel serverless functions)
```

Both entrypoints call `createApp()` and get back a fully-wired Express app (middleware + all routers + error handlers). There is exactly **one** place the app is assembled — `src/app.ts` — everything else just runs it.

---

## 2. Directory Tree

```
NCR-OMS-main/
├── api/                        # Vercel serverless entrypoints
│   ├── index.ts                #   handles "/" 
│   └── [...slug].ts            #   catch-all for every other path
├── scripts/
│   └── smoke.ts                # destructive end-to-end smoke test (real DB + real HTTP)
├── src/
│   ├── app.ts                  # ★ createApp() factory — middleware chain + route mounting
│   ├── server.ts               # process entrypoint: createApp().listen(port)
│   ├── connectors/             # live marketplace API clients (mostly stubs today)
│   │   ├── amazon.ts           #   NotImplementedError per method — no live connector yet
│   │   ├── mock.ts             #   placeholder connector for testing the connector interface
│   │   ├── router.ts           #   picks the right connector by marketplace enum
│   │   └── types.ts
│   ├── db/
│   │   ├── client.ts           # Drizzle + pg pool; requires DATABASE_URL
│   │   └── schema.ts           # full relational schema (companies → ... → purchase entries)
│   ├── ingestion/               # CSV import pipeline (the actually-working order intake path)
│   │   ├── csv.ts               #   generic CSV parsing helpers
│   │   ├── dates.ts             #   marketplace-specific date parsing
│   │   ├── types.ts
│   │   └── parsers/
│   │       ├── flipkart.ts
│   │       ├── meesho.ts
│   │       └── snapdeal.ts
│   ├── middleware/
│   │   ├── auth.ts              # JWT verification + RBAC + company-scoping guard
│   │   └── errorHandler.ts      # notFoundHandler + errorHandler (mounted last in app.ts)
│   ├── modules/                 # business logic, framework-agnostic
│   │   ├── dispatch/dailyDispatch.ts   # picklist + courier-wise packing sheet generation
│   │   ├── inventory/ledger.ts         # append-only stock ledger, advisory-locked writes
│   │   ├── orders/ingest.ts            # order creation + stock reservation, one transaction
│   │   ├── payouts/payouts.ts          # expected vs received, proportional distribution
│   │   ├── pnl/pnl.ts                  # on-request P&L (never stored)
│   │   ├── purchases/purchases.ts      # PO receipt / manual stock adjustment
│   │   └── returns/returns.ts          # return lifecycle incl. "Return Received" step
│   ├── routes/                  # thin HTTP layer — validates input, calls modules/*, shapes response
│   │   ├── auth.ts
│   │   ├── companies.ts
│   │   ├── dispatch.ts
│   │   ├── orders.ts
│   │   ├── payouts.ts
│   │   ├── pnl.ts
│   │   ├── purchases.ts
│   │   ├── returns.ts
│   │   ├── skus.ts
│   │   └── warehouses.ts
│   └── security/
│       ├── crypto.ts            # AES-256-GCM envelope encryption
│       ├── jwt.ts                # HS256 sign/verify
│       └── password.ts          # argon2id hash/verify
├── tests/
│   ├── ingestion.test.ts             # standalone — no DB needed
│   ├── security.test.ts              # standalone — no DB needed
│   ├── orders.integration.test.ts    # needs DATABASE_URL
│   ├── payouts.test.ts               # needs DATABASE_URL
│   └── pnl.test.ts                   # needs DATABASE_URL
├── package.json
├── tsconfig.json
├── vitest.config.ts
├── vercel.json                  # rewrites every path to api/[...slug].ts
├── drizzle.config.ts
├── BRAIN.md                     # ★ living change log / project memory
├── SKILL.md                     # ★ how-to-work-here playbook
├── APP_STRUCTURE.md             # ★ this file
└── BUGRESOLVE.md                # ★ bug history + root causes + fixes
```

---

## 3. Request Lifecycle

```
HTTP request
   │
   ▼
helmet() → cors() → rateLimit() → express.json()/urlencoded()
   │
   ▼
/health                              → inline handler, no auth
/api/auth/*                          → src/routes/auth.ts (login/signup, issues JWT)
/api/{companies,skus,warehouses,...} → auth middleware (src/middleware/auth.ts)
                                          → verifies JWT, attaches req.user + company scope
                                          → RBAC check per route
                                       → route handler (src/routes/*.ts)
                                          → validates body with zod
                                          → calls src/modules/*/*.ts for business logic
                                          → modules/* talk to src/db (Drizzle) directly
   │
   ▼
notFoundHandler (unmatched routes) → errorHandler (catches thrown/async errors, shapes JSON error)
```

---

## 4. Data Model (from `src/db/schema.ts`)

Companies → Brands → Marketplace Accounts (+ encrypted credentials) → SKUs (+ per-marketplace SKU map) → Listings
Warehouses → Inventory Ledger (append-only) → Orders → Order Items → Shipments
Returns (marketplace-reported lifecycle)
Payout Batches → Settlement Lines
Cost Entries, Expenses, Suppliers, Purchase Entries
Users (RBAC: OWNER/ADMIN/OPS/VIEWER), Audit Logs, Bank Accounts (encrypted)

---

## 5. The One Rule That Broke The Build (until this pass)

`src/app.ts` **must** export a named `createApp(): Express` factory function — every consumer (`src/server.ts`, `api/index.ts`, `api/[...slug].ts`, `scripts/smoke.ts`) imports it by that exact name. See `BUGRESOLVE.md` Bug #1 for the incident where this drifted and broke the build.

---

*Maintained with Claude (Anthropic) 🤖 · Last updated: 2026-09-07*
