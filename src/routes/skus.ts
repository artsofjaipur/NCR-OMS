import { Router } from "express";
import { z } from "zod";
import { and, eq } from "drizzle-orm";
import { db } from "../db/client";
import { skus, brands, marketplaceSkuMap, marketplaceAccounts } from "../db/schema";
import { requireSection } from "../security/permissions";
import { requireAuth, requireCompanyScope, requireRole } from "../middleware/auth";
import { HttpError } from "../middleware/errorHandler";

export const skusRouter = Router();
skusRouter.use(requireAuth, requireCompanyScope, requireSection("inventory"));

/** SKU list, always scoped to the caller's company (join brands for the filter). */
skusRouter.get("/", async (req, res, next) => {
  try {
    const brandId = req.query.brandId ? Number(req.query.brandId) : undefined;
    const rows = await db
      .select({
        id: skus.id,
        brandId: skus.brandId,
        code: skus.code,
        productTitle: skus.productTitle,
        color: skus.color,
        size: skus.size,
        hsnCode: skus.hsnCode,
        mrp: skus.mrp,
        isActive: skus.isActive,
      })
      .from(skus)
      .innerJoin(brands, eq(brands.id, skus.brandId))
      .where(
        brandId
          ? and(eq(brands.companyId, req.session!.companyId), eq(skus.brandId, brandId))
          : eq(brands.companyId, req.session!.companyId)
      )
      .orderBy(skus.code)
      .limit(1000);
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

// ---------------------------------------------------------------------------
// Bulk SKU add — paste a list of SKU codes (one per line or CSV) and every
// new code becomes a SKU of the brand. Existing codes are skipped, and every
// new SKU automatically maps to itself for every account of that brand, so
// marketplace CSVs using the same codes import without manual mapping.
// ---------------------------------------------------------------------------
const bulkSchema = z.object({
  brandId: z.number().int().positive(),
  codes: z.string().min(1).max(100_000),
  autoMap: z.boolean().optional(),
});

skusRouter.post("/bulk", requireRole("OWNER", "ADMIN"), async (req, res, next) => {
  try {
    const body = bulkSchema.parse(req.body);
    const [brand] = await db
      .select({ companyId: brands.companyId })
      .from(brands)
      .where(and(eq(brands.id, body.brandId), eq(brands.companyId, req.session!.companyId)))
      .limit(1);
    if (!brand) throw new HttpError(403, "Brand does not belong to your company");

    // Accept "JK-1001-A\nJK-1001-B" or "JK-1001-A,JK-1001-B" or one per line.
    const codes = [...new Set(
      body.codes
        .split(/[\n,;\r]+/)
        .map((c) => c.trim())
        .filter((c) => c.length > 0 && c.length <= 100)
    )];
    if (!codes.length) throw new HttpError(400, "No SKU codes found in the input");

    let created = 0;
    const skipped: string[] = [];
    for (const code of codes) {
      try {
        await db.insert(skus).values({ brandId: body.brandId, code, productTitle: code });
        created += 1;
      } catch {
        skipped.push(code); // unique per brand — already exists
      }
    }

    // Self-map: marketplace SKU string == our SKU code for these brands.
    let mapped = 0;
    if (body.autoMap !== false) {
      const accounts = await db
        .select({ id: marketplaceAccounts.id })
        .from(marketplaceAccounts)
        .where(eq(marketplaceAccounts.brandId, body.brandId));
      const allSkus = await db
        .select({ id: skus.id, code: skus.code })
        .from(skus)
        .where(eq(skus.brandId, body.brandId));
      for (const account of accounts) {
        for (const sku of allSkus) {
          try {
            await db
              .insert(marketplaceSkuMap)
              .values({ marketplaceAccountId: account.id, marketplaceSku: sku.code, skuId: sku.id })
              .onConflictDoNothing();
            mapped += 1;
          } catch { /* conflict handled above */ }
        }
      }
    }

    res.status(201).json({ created, skipped, mapped });
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------------------
// Stock view — current on-hand per SKU (ledger is append-only; stock = SUM).
// ---------------------------------------------------------------------------
import { sql } from "drizzle-orm";
import { inventoryLedger } from "../db/schema";

skusRouter.get("/stock", async (req, res, next) => {
  try {
    const warehouseId = req.query.warehouseId ? Number(req.query.warehouseId) : undefined;
    const rows = await db
      .select({
        skuId: skus.id,
        code: skus.code,
        brand: brands.name,
        warehouseId: inventoryLedger.warehouseId,
        onHand: sql<number>`coalesce(sum(${inventoryLedger.delta}), 0)::int`,
      })
      .from(skus)
      .innerJoin(brands, eq(brands.id, skus.brandId))
      .leftJoin(
        inventoryLedger,
        warehouseId
          ? and(eq(inventoryLedger.skuId, skus.id), eq(inventoryLedger.warehouseId, warehouseId))
          : eq(inventoryLedger.skuId, skus.id)
      )
      .where(eq(brands.companyId, req.session!.companyId))
      .groupBy(skus.id, skus.code, brands.name, inventoryLedger.warehouseId)
      .orderBy(skus.code);
    res.json(rows);
  } catch (err) {
    next(err);
  }
});
