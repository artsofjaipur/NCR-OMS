# SKILL.md — How to Work On NCR-OMS

> This is a working playbook for any AI assistant (or human) making changes to this repository. It encodes the conventions already in the codebase so new work fits in, plus the process rules requested for this project (immediate BRAIN.md updates, Claude signature, etc).
>
> Generated and maintained by: **Claude (Anthropic)** 🤖

---

## 1. Golden Rules

1. **Update `BRAIN.md` immediately after every change.** Not at the end of a session — the same turn the change is made. See `BRAIN.md` § 5 for the exact protocol.
2. **Sign your work.** Any file substantially created or fixed gets a short header comment noting it was touched by Claude (Anthropic), plus a one-line note of *why*. See § 5 below for the exact format.
3. **Never guess a fix — verify it.** Every code change is checked with `npx tsc -p tsconfig.json --noEmit` and, where relevant, `npx vitest run` before it's considered done.
4. **Document real bugs in `BUGRESOLVE.md`**, not just in code comments — future readers need the "why," not just the "what."
5. **Don't touch `DATABASE_URL`-dependent tests' expectations to make them "pass."** If they fail only because no DB is configured in the current environment, that's an environment gap, not a code bug — say so explicitly (see `BRAIN.md` § 4).

---

## 2. Tech Stack & Conventions Already In Use

- **Language:** TypeScript, strict mode (`tsconfig.json`). No `any` unless already present in existing code (e.g. the two Vercel handler shims in `api/`, which is intentional there).
- **Runtime:** Node.js ≥ 20 (repo targets 22), CommonJS module type (`package.json` → `"type": "commonjs"`).
- **Web framework:** Express 4. The app is always constructed via `createApp()` in `src/app.ts` — **never instantiate a second, separate Express app elsewhere.**
- **DB:** PostgreSQL + Drizzle ORM. Schema lives in `src/db/schema.ts`; client in `src/db/client.ts`.
- **Security:** argon2id (passwords), AES-256-GCM envelope encryption (`src/security/crypto.ts`), JWT HS256 (`src/security/jwt.ts`), RBAC roles `OWNER/ADMIN/OPS/VIEWER`.
- **Validation:** `zod` for request schemas.
- **Testing:** `vitest`. Split into standalone unit tests (no DB needed: `ingestion.test.ts`, `security.test.ts`) and integration tests that need a real, disposable Postgres (`orders.integration.test.ts`, `payouts.test.ts`, `pnl.test.ts`).
- **Money:** stored as integer paise/cents-equivalent smallest unit — never floats. Check existing modules (`pnl`, `payouts`) before introducing new monetary fields.
- **Inventory:** append-only ledger pattern (`inventoryLedger` table) — stock is always `SUM(delta)`, never a mutable counter. Writes are serialized per SKU/warehouse via a Postgres advisory lock. Don't add a second "current stock" column anywhere.

---

## 3. Standard Workflow For a Change

```
1. Read the relevant module(s) + its route + its test, if any.
2. Make the smallest correct change.
3. Run:
     npx tsc -p tsconfig.json --noEmit
     npx vitest run          (add DATABASE_URL for integration suites if testing DB-backed logic)
4. If it's a bug fix:
     - Add an entry to BUGRESOLVE.md (root cause, fix, verification)
     - Add a Claude-signature header comment to the file(s) changed (see §5)
5. Update BRAIN.md § 2 Change Log — immediately, same turn.
6. If applicable, update APP_STRUCTURE.md if the file/module layout changed.
```

---

## 4. Where Things Live (quick map — see `APP_STRUCTURE.md` for full detail)

| Concern | Path |
|---|---|
| App wiring / middleware chain | `src/app.ts` (factory: `createApp()`) |
| Process entrypoint (local/dev) | `src/server.ts` |
| Vercel serverless entrypoints | `api/index.ts`, `api/[...slug].ts` |
| Routes (HTTP layer only) | `src/routes/*.ts` |
| Business logic | `src/modules/*/*.ts` |
| DB schema | `src/db/schema.ts` |
| DB client | `src/db/client.ts` |
| Marketplace CSV parsers | `src/ingestion/parsers/*.ts` |
| Marketplace live-API connectors (mostly stubs) | `src/connectors/*.ts` |
| Auth/session/crypto | `src/security/*.ts` |
| Express middleware (auth guard, error handler) | `src/middleware/*.ts` |
| Tests | `tests/*.ts` |
| One-off destructive smoke test | `scripts/smoke.ts` |

---

## 5. Claude Signature Format

When Claude creates or meaningfully fixes a file in this repo, add a short header comment (using that file's comment syntax) near the top, e.g. for TypeScript:

```ts
/**
 * <one-line description of what this file does>
 * Fixed/Created by Claude (Anthropic) — <one-line why>.
 * See BUGRESOLVE.md for details if this was a bug fix.
 */
```

For Markdown files, a footer line is enough:

```
*Maintained with Claude (Anthropic) 🤖*
```

Don't sign files that weren't actually touched — the signature marks real authorship/fix history, not decoration.

---

*Maintained with Claude (Anthropic) 🤖*
