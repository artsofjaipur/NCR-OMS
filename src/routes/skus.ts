import { Router } from "express";
import { z } from "zod";
import { and, eq } from "drizzle-orm";
import { db } from "../db/client";
import { skus, brands, marketplaceSkuMap, marketplaceAccounts } from "../db/schema";
import { requireAuth, requireCompanyScope } from "../middleware/auth";
import { HttpError } from "../middleware/errorHandler";

export const skusRouter = Router();
skusRouter.use(requireAuth, requireCompanyScope);

/** Closes the "no CRUD API routes for SKUs" gap from the earlier build. */
skusRouter.get("/", async (req, res, next) => {
  try {
    const brandId = req.query.brandId ? Number(req.query.brandId) : undefined;
    const rows = brandId
      ? await db.select().from(skus).where(eq(skus.brandId, brandId))
      : await db.select().from(skus);
    res.json(rows);
  } catch (err) {
    next(err);
  }
});

const createSkuSchema = z.object({
  brandId: z.number().int().positive(),
  code: z.string().min(1),
  productTitle: z.string().min(1),
  color: z.string().optional(),
  size: z.string().optional(),
  hsnCode: z.string().optional(),
  mrp: z.string().optional(),
});

skusRouter.post("/", async (req, res, next) => {
  try {
    const body = createSkuSchema.parse(req.body);
    const [brand] = await db.select({ companyId: brands.companyId }).from(brands).where(eq(brands.id, body.brandId)).limit(1);
    if (!brand || brand.companyId !== req.session!.companyId) {
      throw new HttpError(403, "Brand does not belong to your company");
    }
    // SKU codes are unique per brand, not globally — see the architecture
    // addendum: the same code is legitimately reused across brands.
    const [row] = await db.insert(skus).values(body).returning({ id: skus.id });
    res.status(201).json({ id: row.id });
  } catch (err) {
    next(err);
  }
});

const updateSkuSchema = createSkuSchema.partial().omit({ brandId: true });

skusRouter.patch("/:id", async (req, res, next) => {
  try {
    const body = updateSkuSchema.parse(req.body);
    await db.update(skus).set(body).where(eq(skus.id, Number(req.params.id)));
    res.status(204).end();
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------------------
// Marketplace SKU mapping — teaches ingestion what a marketplace's catalog
// string ("Svm-02_Blue_XL") means in canonical SKU terms. Imports fail with
// UnmappedSkuError until the referenced marketplace SKU is mapped here.
// ---------------------------------------------------------------------------
const mapSchema = z.object({
  marketplaceAccountId: z.number().int().positive(),
  marketplaceSku: z.string().trim().min(1).max(200),
  skuId: z.number().int().positive(),
});

skusRouter.post("/map", async (req, res, next) => {
  try {
    const body = mapSchema.parse(req.body);

    // Both the account and the SKU must belong to the caller's company.
    const [account] = await db
      .select({ brandId: marketplaceAccounts.brandId })
      .from(marketplaceAccounts)
      .where(eq(marketplaceAccounts.id, body.marketplaceAccountId))
      .limit(1);
    if (!account) throw new HttpError(404, "Marketplace account not found");

    const [accountBrand] = await db
      .select({ companyId: brands.companyId })
      .from(brands)
      .where(eq(brands.id, account.brandId))
      .limit(1);
    const [skuBrand] = await db
      .select({ brandId: skus.brandId })
      .from(skus)
      .where(eq(skus.id, body.skuId))
      .limit(1);
    if (!skuBrand) throw new HttpError(404, "SKU not found");
    const [skuBrandCompany] = await db
      .select({ companyId: brands.companyId })
      .from(brands)
      .where(eq(brands.id, skuBrand.brandId))
      .limit(1);

    const companyId = req.session!.companyId;
    if (!accountBrand || accountBrand.companyId !== companyId || !skuBrandCompany || skuBrandCompany.companyId !== companyId) {
      throw new HttpError(403, "Account and SKU must both belong to your company");
    }

    // Re-mapping the same marketplace SKU updates the target instead of erroring.
    const [row] = await db
      .insert(marketplaceSkuMap)
      .values({
        marketplaceAccountId: body.marketplaceAccountId,
        marketplaceSku: body.marketplaceSku,
        skuId: body.skuId,
      })
      .onConflictDoUpdate({
        target: [marketplaceSkuMap.marketplaceAccountId, marketplaceSkuMap.marketplaceSku],
        set: { skuId: body.skuId },
      })
      .returning({ id: marketplaceSkuMap.id });
    res.status(201).json({ id: row.id });
  } catch (err) {
    next(err);
  }
});

skusRouter.get("/mappings", async (req, res, next) => {
  try {
    const accountId = Number(req.query.marketplaceAccountId);
    if (!Number.isInteger(accountId) || accountId <= 0) {
      throw new HttpError(400, "marketplaceAccountId query param is required");
    }
    const rows = await db
      .select({
        id: marketplaceSkuMap.id,
        marketplaceSku: marketplaceSkuMap.marketplaceSku,
        skuId: marketplaceSkuMap.skuId,
        skuCode: skus.code,
      })
      .from(marketplaceSkuMap)
      .innerJoin(skus, eq(skus.id, marketplaceSkuMap.skuId))
      .innerJoin(marketplaceAccounts, eq(marketplaceAccounts.id, marketplaceSkuMap.marketplaceAccountId))
      .innerJoin(brands, eq(brands.id, marketplaceAccounts.brandId))
      .where(and(eq(marketplaceSkuMap.marketplaceAccountId, accountId), eq(brands.companyId, req.session!.companyId)));
    res.json(rows);
  } catch (err) {
    next(err);
  }
});
