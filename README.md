# OMS Backend

Custom order management system for a multi-brand, multi-marketplace apparel operation (Nyko Mart/Vardhamati, Rugara/Arvagam, Casa Arra/Kanjush selling on Flipkart, Meesho, Snapdeal, Amazon, Myntra, Ajio).

Stack: Node.js 22, TypeScript (strict), Express, PostgreSQL 16, Drizzle ORM.

## What's here

- **Data model** (`src/db/schema.ts`): companies, bank accounts, users, audit logs, brands, marketplace accounts, SKUs (+ per-marketplace SKU mapping), listings, warehouses, append-only inventory ledger, orders/order items/shipments, returns, payout batches/settlement lines, cost entries, expenses, suppliers, purchase entries.
- **Real CSV parsers** (`src/ingestion/parsers/`) for Flipkart, Meesho, and Snapdeal order exports, built directly from sample files — see the field-mapping notes in each parser and in the project's architecture doc.
- **Order ingestion** (`src/modules/orders/ingest.ts`): order creation and every line item's stock reservation happen in one transaction. A failed reservation (insufficient stock or an unmapped SKU) rolls back the whole order. Idempotent on (marketplace account, marketplace order id).
- **Inventory ledger** (`src/modules/inventory/ledger.ts`): append-only, current stock = SUM(delta), writes serialized per SKU/warehouse via a Postgres advisory lock, oversell blocked at the write.
- **Payout tracking** (`src/modules/payouts/`): Expected vs Received per batch, confirmation entered once per batch and distributed proportionally across orders.
- **P&L** (`src/modules/pnl/`): computed on request, never stored — settled amount minus period-dated COGS, rolled up brand/company.
- **Returns** (`src/modules/returns/`): marketplace-reported Return lifecycle, with Return Received split out as its own warehouse-floor confirmation step.
- **Daily Dispatch** (`src/modules/dispatch/`): generates the picklist and courier-wise packing sheet in the same shape as the supplier manifest PDFs this was modeled on.
- **Purchase Entry & Direct Stock Update** (`src/modules/purchases/`): PO-backed goods receipt or a reasoned manual stock adjustment, both hit the ledger the same way.
- **Security**: AES-256-GCM envelope encryption (marketplace credentials, bank account numbers), argon2id password hashing, JWT sessions (HS256 pinned), RBAC (OWNER/ADMIN/OPS/VIEWER), company-scoping middleware, rate limiting, CORS allow-list, helmet security headers.
- Deployable as a persistent process (`src/server.ts`) or as a Vercel serverless function (`api/[...slug].ts`) from the same Express app (`src/app.ts`).

## Local setup

```bash
npm install
cp .env.example .env
# fill in DATABASE_URL, ENCRYPTION_MASTER_KEY, JWT_SECRET in .env
npm run db:push   # creates all tables in the target database
npm run dev       # http://localhost:3000
```

Generate the two secrets:

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"  # ENCRYPTION_MASTER_KEY
node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"  # JWT_SECRET
```

## Tests

```bash
npm test
```

The security tests (`tests/security.test.ts`) and parser tests (`tests/ingestion.test.ts`) run standalone. The integration tests (`tests/orders.integration.test.ts`, `tests/payouts.test.ts`, `tests/pnl.test.ts`) need a real Postgres reachable via `DATABASE_URL` — they push the schema themselves and truncate between tests, so point `DATABASE_URL` at a disposable database, not production.

## Deploy: Supabase + Vercel

1. **Create a Supabase project** (or use an existing one). From Project Settings → Database, copy two connection strings:
   - **Session pooler** (port 5432) — use this as `DATABASE_URL` when running `npm run db:push` from your own machine to create the tables.
   - **Transaction pooler** (port 6543) — use this as `DATABASE_URL` in Vercel's environment variables; it's built for exactly the many-short-lived-connections pattern serverless functions create.
2. **Push the schema** once, from your machine, against the Session pooler URL:
   ```bash
   DATABASE_URL="<session-pooler-url>" npm run db:push
   ```
3. **Push this repo to GitHub**, then in Vercel: *Add New → Project → Import* the repo.
4. **Set environment variables** in the Vercel project (Settings → Environment Variables): `DATABASE_URL` (Transaction pooler URL), `DATABASE_POOL_MAX=3`, `ENCRYPTION_MASTER_KEY`, `JWT_SECRET`, `CORS_ALLOWED_ORIGINS`. Vercel builds with `npm run build` and serves `api/[...slug].ts` as the catch-all function; `vercel.json` rewrites every other path to it, so routes work the same as they do locally (`/orders`, `/dispatch/...`, etc. — no `/api` prefix needed from the client).
5. **Deploy.** Every push to the connected branch redeploys automatically.

Known gap: this split is verified by local build/test against a real local Postgres, not by an actual live deploy against a real Supabase project — worth a real end-to-end deploy check once real credentials exist.

## Known gaps

- Marketplace *live-API* connectors (`src/connectors/mock.ts`) are placeholders — the real, working order ingestion path today is the CSV importers (`POST /orders/import/:marketplace`). Amazon has no connector at all yet (`NotImplementedError` per method, honestly, rather than a silent no-op).
- Return/RTO field mapping only has real evidence from Snapdeal's export so far — no Flipkart or Meesho return-report samples yet.
- Meesho's "Ready to Ship" export has no AWB or address — Daily Dispatch can't hand off Meesho orders end to end until a Meesho label/manifest export is available to parse.
- No UI — this is the API layer only.
