/**
 * Company profile + workspace management. `POST /` (multi-company support)
 * added by Claude (Anthropic) 2026-09-11 — see BRAIN.md for why: this system
 * was one-company-per-login, so a group with several legal entities (Nyko
 * Mart / Casa Arra / Rugara) had no way to see or add a second company
 * without a brand-new, unrelated `/auth/register` signup — and no way to
 * switch back without logging out and back in. Pairs with `GET
 * /auth/my-companies` + `POST /auth/switch-company` in `src/routes/auth.ts`.
 * `DELETE /me` added the same day — see the guard rationale on that route.
 */
import { Router } from "express";
import { z } from "zod";
import { and, eq } from "drizzle-orm";
import { db } from "../db/client";
import { companies, bankAccounts, brands, expenses, marketplaceAccounts, orders, purchaseEntries, skus, users, warehouses } from "../db/schema";
import { requireAuth, requireCompanyScope, requireRole } from "../middleware/auth";
import { encrypt, encryptJson } from "../security/crypto";
import { HttpError } from "../middleware/errorHandler";
import { signSession } from "../security/jwt";
import { resolveSections } from "../security/permissions";

export const companiesRouter = Router();
companiesRouter.use(requireAuth, requireCompanyScope);

// ---------------------------------------------------------------------------
// Additional company for the SAME identity (same email) — e.g. an OWNER who
// runs Nyko Mart adding Casa Arra and Rugara as separate legal entities
// without creating an unrelated new login. Distinct from POST /auth/register
// (public, unauthenticated, always starts a brand-new identity+company).
// Restricted to OWNER: this creates a new tenant, not just workspace data.
// ---------------------------------------------------------------------------

const newCompanySchema = z.object({
  legalName: z.string().min(1).max(200),
  displayName: z.string().min(1).max(150).optional(),
});

companiesRouter.post("/", requireRole("OWNER"), async (req, res, next) => {
  try {
    const body = newCompanySchema.parse(req.body);

    const [me] = await db
      .select({ email: users.email, displayName: users.displayName, passwordHash: users.passwordHash })
      .from(users)
      .where(eq(users.id, req.session!.userId))
      .limit(1);
    if (!me) throw new HttpError(404, "Current user not found");

    const result = await db.transaction(async (tx) => {
      const [company] = await tx
        .insert(companies)
        .values({ legalName: body.legalName, displayName: body.displayName ?? body.legalName })
        .returning({ id: companies.id, displayName: companies.displayName });

      await tx.insert(warehouses).values({ companyId: company.id, name: "Main Warehouse", isDefault: true });

      // Same email + same existing password hash, new company — the
      // (companyId, email) unique index this schema already uses is exactly
      // what makes this safe: one identity, many per-company user rows,
      // never a cross-company collision. Reusing the hash (not re-hashing a
      // plaintext password we don't have here) means one password works
      // across every company this identity owns, until changed per-row.
      const [user] = await tx
        .insert(users)
        .values({
          companyId: company.id,
          email: me.email,
          passwordHash: me.passwordHash,
          role: "OWNER",
          displayName: me.displayName,
        })
        .returning({ id: users.id });

      return { companyId: company.id, companyName: company.displayName, userId: user.id };
    });

    // Hand back a session already switched to the new company — no second
    // round-trip needed to start using it.
    const token = signSession({ userId: result.userId, companyId: result.companyId, role: "OWNER" });
    res.status(201).json({ companyId: result.companyId, companyName: result.companyName, token });
  } catch (err) {
    next(err);
  }
});

companiesRouter.get("/me", async (req, res, next) => {
  try {
    const [company] = await db.select().from(companies).where(eq(companies.id, req.session!.companyId)).limit(1);
    if (!company) throw new HttpError(404, "Company not found");
    const accounts = await db.select().from(bankAccounts).where(eq(bankAccounts.companyId, company.id));
    // Never return the encrypted account number blob to the client.
    res.json({
      ...company,
      bankAccounts: accounts.map(({ accountNumberEncrypted, ...rest }) => ({ ...rest, accountNumberMasked: "••••" })),
    });
  } catch (err) {
    next(err);
  }
});

/**
 * Delete the CURRENT session's company — OWNER-only, and deliberately
 * conservative: most `companyId` foreign keys in this schema cascade-delete
 * (brands, marketplace accounts, orders, warehouses, SKUs...), so a plain
 * `DELETE FROM companies` would silently wipe real order/return/shipment
 * history if we let it. Refused (409) instead whenever there's any real
 * business activity — same "never silently destroy data" pattern as brand/
 * supplier/warehouse deletion elsewhere in this router. Also refused when
 * this is the caller's only company (an identity must always have at least
 * one to log into). On success the session is switched to another company
 * under the same identity, same response shape as `POST /auth/switch-company`.
 */
companiesRouter.delete("/me", requireRole("OWNER"), async (req, res, next) => {
  try {
    const companyId = req.session!.companyId;

    const [me] = await db.select({ email: users.email }).from(users).where(eq(users.id, req.session!.userId)).limit(1);
    if (!me) throw new HttpError(404, "Current user not found");

    const siblingRows = await db
      .select({ companyId: users.companyId })
      .from(users)
      .where(and(eq(users.email, me.email), eq(users.isActive, true)));
    const hasAnotherCompany = siblingRows.some((r) => r.companyId !== companyId);
    if (!hasAnotherCompany) {
      throw new HttpError(
        409,
        "Yeh aapki akeli company hai — kam se kam ek company hamesha honi chahiye. Pehle ek aur company banao, phir ise delete karein.",
      );
    }

    const [orderHit] = await db
      .select({ id: orders.id })
      .from(orders)
      .innerJoin(marketplaceAccounts, eq(marketplaceAccounts.id, orders.marketplaceAccountId))
      .innerJoin(brands, eq(brands.id, marketplaceAccounts.brandId))
      .where(eq(brands.companyId, companyId))
      .limit(1);
    const [purchaseHit] = await db.select({ id: purchaseEntries.id }).from(purchaseEntries).where(eq(purchaseEntries.companyId, companyId)).limit(1);
    // expenses is brand-scoped (no direct companyId), so reach it via brands.
    const [expenseHit] = await db
      .select({ id: expenses.id })
      .from(expenses)
      .innerJoin(brands, eq(brands.id, expenses.brandId))
      .where(eq(brands.companyId, companyId))
      .limit(1);
    if (orderHit || purchaseHit || expenseHit) {
      throw new HttpError(
        409,
        "Is company me orders/purchases/expenses ka real data hai, isliye safety ke liye delete nahi ho sakti. Sirf ek khaali/galti se bani company delete ho sakti hai.",
      );
    }

    const [deletedCompany] = await db
      .select({ displayName: companies.displayName })
      .from(companies)
      .where(eq(companies.id, companyId))
      .limit(1);

    // Cascades remove this company's own users/brands/warehouses/bank
    // accounts/etc. with it — the checks above already ruled out anything
    // with real transactional history.
    await db.delete(companies).where(eq(companies.id, companyId));

    const [fallback] = await db
      .select()
      .from(users)
      .where(and(eq(users.email, me.email), eq(users.isActive, true)))
      .limit(1);
    if (!fallback) {
      // Shouldn't happen given the hasAnotherCompany check above, but don't
      // leave the client holding a session scoped to a company that no
      // longer exists.
      throw new HttpError(500, "Company deleted, but no fallback workspace could be found. Please log in again.");
    }

    const token = signSession({ userId: fallback.id, companyId: fallback.companyId, role: fallback.role });
    const [fallbackCompany] = await db
      .select({ displayName: companies.displayName })
      .from(companies)
      .where(eq(companies.id, fallback.companyId))
      .limit(1);

    res.json({
      deletedCompanyName: deletedCompany?.displayName ?? null,
      token,
      userId: fallback.id,
      companyId: fallback.companyId,
      role: fallback.role,
      displayName: fallback.displayName,
      companyName: fallbackCompany?.displayName ?? null,
      permissions: await resolveSections({ session: { userId: fallback.id, role: fallback.role } } as never),
    });
  } catch (err) {
    next(err);
  }
});

const profileSchema = z.object({
  legalName: z.string().min(1).optional(),
  displayName: z.string().min(1).optional(),
  logoUrl: z.string().url().optional(),
  gstin: z.string().length(15).optional(),
  pan: z.string().length(10).optional(),
  // Company setup fields (order prefix + export + contact), 2026-09-10
  orderReferencePrefix: z.string().trim().max(20).optional(),
  iec: z.string().trim().max(20).optional(),
  phone: z.string().trim().max(20).optional(),
  whatsapp: z.string().trim().max(20).optional(),
  email: z.string().trim().email().max(255).optional(),
  addressLine1: z.string().optional(),
  addressLine2: z.string().optional(),
  city: z.string().optional(),
  state: z.string().optional(),
  stateCode: z.string().length(2).optional(),
  pincode: z.string().length(6).optional(),
  signatoryName: z.string().optional(),
  signatoryDesignation: z.string().optional(),
});

companiesRouter.patch("/me", requireRole("OWNER", "ADMIN"), async (req, res, next) => {
  try {
    const body = profileSchema.parse(req.body);
    await db.update(companies).set(body).where(eq(companies.id, req.session!.companyId));
    res.status(204).end();
  } catch (err) {
    next(err);
  }
});

const bankAccountSchema = z.object({
  label: z.string().min(1),
  accountHolderName: z.string().min(1),
  accountNumber: z.string().min(4),
  ifsc: z.string().length(11),
  bankName: z.string().min(1),
  branchName: z.string().optional(),
  adCode: z.string().trim().max(30).optional(),
  accountType: z.string().optional(),
  isPrimary: z.boolean().optional(),
});

companiesRouter.post("/me/bank-accounts", requireRole("OWNER", "ADMIN"), async (req, res, next) => {
  try {
    const body = bankAccountSchema.parse(req.body);
    const [row] = await db
      .insert(bankAccounts)
      .values({
        companyId: req.session!.companyId,
        label: body.label,
        accountHolderName: body.accountHolderName,
        accountNumberEncrypted: encrypt(body.accountNumber),
        ifsc: body.ifsc,
        bankName: body.bankName,
        branchName: body.branchName,
        adCode: body.adCode,
        accountType: body.accountType,
        isPrimary: body.isPrimary ?? false,
      })
      .returning({ id: bankAccounts.id });
    res.status(201).json({ id: row.id });
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------------------
// Brand setup — the workspace's product families. Every order, SKU and
// marketplace account hangs off one of these.
// ---------------------------------------------------------------------------
const brandSchema = z.object({
  name: z.string().trim().min(2).max(150),
});

companiesRouter.get("/me/brands", async (req, res, next) => {
  try {
    const rows = await db
      .select({ id: brands.id, name: brands.name })
      .from(brands)
      .where(eq(brands.companyId, req.session!.companyId))
      .orderBy(brands.id);
    res.json(rows);
  } catch (err) {
    next(err);
  }
});

companiesRouter.post("/me/brands", requireRole("OWNER", "ADMIN"), async (req, res, next) => {
  try {
    const body = brandSchema.parse(req.body);
    const [row] = await db
      .insert(brands)
      .values({ companyId: req.session!.companyId, name: body.name })
      .returning({ id: brands.id, name: brands.name });
    res.status(201).json(row);
  } catch (err) {
    next(err);
  }
});

// Rename a brand — safe, no history is lost.
const brandRenameSchema = z.object({ name: z.string().trim().min(2).max(150) });

companiesRouter.patch("/me/brands/:id", requireRole("OWNER", "ADMIN"), async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) throw new HttpError(400, "Invalid brand id");
    const body = brandRenameSchema.parse(req.body);
    const [owned] = await db
      .select({ id: brands.id })
      .from(brands)
      .where(and(eq(brands.id, id), eq(brands.companyId, req.session!.companyId)))
      .limit(1);
    if (!owned) throw new HttpError(404, "Brand not found in your workspace");
    await db.update(brands).set({ name: body.name }).where(eq(brands.id, id));
    res.status(204).end();
  } catch (err) {
    next(err);
  }
});

/**
 * Delete a brand — only when it has no orders yet. A brand with order history
 * is part of the ledger (stock reservations, returns, payouts), so deletion is
 * refused and the error explains why.
 */
companiesRouter.delete("/me/brands/:id", requireRole("OWNER", "ADMIN"), async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) throw new HttpError(400, "Invalid brand id");
    const [owned] = await db
      .select({ id: brands.id })
      .from(brands)
      .where(and(eq(brands.id, id), eq(brands.companyId, req.session!.companyId)))
      .limit(1);
    if (!owned) throw new HttpError(404, "Brand not found in your workspace");

    const [orderHit] = await db
      .select({ count: orders.id })
      .from(orders)
      .innerJoin(marketplaceAccounts, eq(marketplaceAccounts.id, orders.marketplaceAccountId))
      .where(eq(marketplaceAccounts.brandId, id))
      .limit(1);
    if (orderHit) {
      throw new HttpError(409, "This brand has orders — it cannot be deleted because its order history, stock ledger and payouts reference it. Rename it instead.");
    }

    // No orders: cascade removes its accounts/SKUs/mappings with it.
    await db.delete(brands).where(eq(brands.id, id));
    res.status(204).end();
  } catch (err) {
    next(err);
  }
});

/** Rename a seller account (label only — marketplace identity never changes). */
companiesRouter.patch("/me/marketplace-accounts/:id", requireRole("OWNER", "ADMIN"), async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) throw new HttpError(400, "Invalid account id");
    const parsed = z.object({ sellerAccountLabel: z.string().trim().min(1).max(150).optional(), isActive: z.boolean().optional() }).parse(req.body);
    const [account] = await db
      .select({ brandId: marketplaceAccounts.brandId })
      .from(marketplaceAccounts)
      .where(eq(marketplaceAccounts.id, id))
      .limit(1);
    if (!account) throw new HttpError(404, "Account not found");
    const [owned] = await db
      .select({ id: brands.id })
      .from(brands)
      .where(and(eq(brands.id, account.brandId), eq(brands.companyId, req.session!.companyId)))
      .limit(1);
    if (!owned) throw new HttpError(403, "Account does not belong to your company");
    const patch: Record<string, unknown> = {};
    if (parsed.sellerAccountLabel !== undefined) patch.sellerAccountLabel = parsed.sellerAccountLabel;
    if (parsed.isActive !== undefined) patch.isActive = parsed.isActive;
    if (Object.keys(patch).length === 0) return res.status(204).end();
    await db.update(marketplaceAccounts).set(patch).where(eq(marketplaceAccounts.id, id));
    res.status(204).end();
  } catch (err) {
    next(err);
  }
});

/** SKU list per brand with mapping info — drives the Brands manage UI. */
companiesRouter.get("/me/brands/:id/skus", async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) throw new HttpError(400, "Invalid brand id");
    const [owned] = await db
      .select({ id: brands.id })
      .from(brands)
      .where(and(eq(brands.id, id), eq(brands.companyId, req.session!.companyId)))
      .limit(1);
    if (!owned) throw new HttpError(404, "Brand not found in your workspace");
    const rows = await db
      .select({ id: skus.id, code: skus.code, productTitle: skus.productTitle, size: skus.size, isActive: skus.isActive })
      .from(skus)
      .where(eq(skus.brandId, id))
      .orderBy(skus.code)
      .limit(500);
    res.json(rows);
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------------------
// Marketplace (seller) accounts — one per brand × marketplace × label. CSV
// imports land against one of these. Credentials are stored AES-256-GCM
// encrypted; manual/CSV-only setups can pass an empty object.
// ---------------------------------------------------------------------------
const marketplaceEnumValues = [
  "FLIPKART",
  "MEESHO",
  "SNAPDEAL",
  "AMAZON_IN",
  "AMAZON_COM",
  "MYNTRA",
  "AJIO",
] as const;

const accountSchema = z.object({
  brandId: z.number().int().positive(),
  marketplace: z.enum(marketplaceEnumValues),
  sellerAccountLabel: z.string().trim().min(1).max(150),
  payoutCycleDays: z.number().int().min(1).max(120).optional(),
  credentials: z.record(z.string()).optional(),
});

companiesRouter.post("/me/marketplace-accounts", requireRole("OWNER", "ADMIN"), async (req, res, next) => {
  try {
    const body = accountSchema.parse(req.body);

    const [brand] = await db
      .select({ id: brands.id })
      .from(brands)
      .where(and(eq(brands.id, body.brandId), eq(brands.companyId, req.session!.companyId)))
      .limit(1);
    if (!brand) throw new HttpError(403, "Brand does not belong to your company");

    const [row] = await db
      .insert(marketplaceAccounts)
      .values({
        brandId: body.brandId,
        marketplace: body.marketplace,
        sellerAccountLabel: body.sellerAccountLabel,
        payoutCycleDays: body.payoutCycleDays,
        // Connector creds (API keys/tokens) are envelope-encrypted at rest.
        // CSV-only workflows still need a non-null blob — store an empty map.
        credentialsEncrypted: encryptJson(body.credentials ?? {}),
      })
      .returning({ id: marketplaceAccounts.id, sellerAccountLabel: marketplaceAccounts.sellerAccountLabel });
    res.status(201).json(row);
  } catch (err) {
    next(err);
  }
});
