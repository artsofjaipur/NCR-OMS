import { Router } from "express";
import { z } from "zod";
import { and, eq } from "drizzle-orm";
import { db } from "../db/client";
import { companies, bankAccounts, brands, marketplaceAccounts } from "../db/schema";
import { requireAuth, requireCompanyScope, requireRole } from "../middleware/auth";
import { encrypt, encryptJson } from "../security/crypto";
import { HttpError } from "../middleware/errorHandler";

export const companiesRouter = Router();
companiesRouter.use(requireAuth, requireCompanyScope);

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

const profileSchema = z.object({
  legalName: z.string().min(1).optional(),
  displayName: z.string().min(1).optional(),
  logoUrl: z.string().url().optional(),
  gstin: z.string().length(15).optional(),
  pan: z.string().length(10).optional(),
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
