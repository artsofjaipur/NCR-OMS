import { Router } from "express";
import { and, eq, sql, ilike, or } from "drizzle-orm";
import { db } from "../db/client";
import { inventoryLedger, skus, brands, warehouses } from "../db/schema";
import { requireAuth, requireCompanyScope } from "../middleware/auth";
import { requireSection } from "../security/permissions";

export const inventoryRouter = Router();
inventoryRouter.use(requireAuth, requireCompanyScope, requireSection("inventory"));

/**
 * Inventory / Stock report — SKU × size × product wise, added 2026-09-25 per
 * user request ("stock entry stock report sku size product wise"). Current
 * stock is never a stored counter (see modules/inventory/ledger.ts) — it's
 * always SUM(delta) over the append-only inventoryLedger, so this is
 * computed live from every PURCHASE_RECEIPT / ORDER_RESERVED / DISPATCHED /
 * RETURN_RESTOCK / MANUAL_ADJUSTMENT row ever written, including the new
 * Stock-In ledger (see routes/purchases.ts) and CSV imports. A SKU with no
 * ledger rows at all (never received) is left out — nothing to report.
 */
inventoryRouter.get("/stock", async (req, res, next) => {
  try {
    const companyId = req.session!.companyId;
    const brandId = req.query.brandId ? Number(req.query.brandId) : undefined;
    const search = typeof req.query.q === "string" ? req.query.q.trim() : "";

    const rows = await db
      .select({
        skuId: skus.id,
        code: skus.code,
        productTitle: skus.productTitle,
        color: skus.color,
        size: skus.size,
        brandId: skus.brandId,
        brandName: brands.name,
        warehouseId: warehouses.id,
        warehouseName: warehouses.name,
        qty: sql<string>`coalesce(sum(${inventoryLedger.delta}), 0)::text`,
      })
      .from(inventoryLedger)
      .innerJoin(skus, eq(skus.id, inventoryLedger.skuId))
      .innerJoin(brands, eq(brands.id, skus.brandId))
      .innerJoin(warehouses, eq(warehouses.id, inventoryLedger.warehouseId))
      .where(
        and(
          eq(brands.companyId, companyId),
          brandId ? eq(skus.brandId, brandId) : undefined,
          search
            ? or(ilike(skus.code, `%${search}%`), ilike(skus.productTitle, `%${search}%`), ilike(skus.size, `%${search}%`), ilike(skus.color, `%${search}%`))
            : undefined,
        ),
      )
      .groupBy(skus.id, skus.code, skus.productTitle, skus.color, skus.size, skus.brandId, brands.name, warehouses.id, warehouses.name)
      .orderBy(skus.code);

    // Aggregate per-warehouse rows into one SKU-level record each, with a
    // warehouse breakdown — current stock is never negative-filtered out,
    // since a negative total is the honest "a stock-in is overdue" signal
    // this app already relies on elsewhere (see ledger.ts).
    const bySku = new Map<number, any>();
    for (const r of rows) {
      let entry = bySku.get(r.skuId);
      if (!entry) {
        entry = {
          skuId: r.skuId,
          code: r.code,
          productTitle: r.productTitle,
          color: r.color,
          size: r.size,
          brandId: r.brandId,
          brandName: r.brandName,
          totalQty: 0,
          warehouses: [],
        };
        bySku.set(r.skuId, entry);
      }
      const qty = Number(r.qty);
      entry.totalQty += qty;
      if (qty !== 0) entry.warehouses.push({ warehouseId: r.warehouseId, warehouseName: r.warehouseName, qty });
    }

    const result = Array.from(bySku.values()).sort((a, b) => a.code.localeCompare(b.code));
    res.json(result);
  } catch (err) {
    next(err);
  }
});

/** Roll-up by product (ignoring size) and by size (ignoring product) — the two "grouped" views the report toggles between. */
inventoryRouter.get("/stock/summary", async (req, res, next) => {
  try {
    const companyId = req.session!.companyId;
    const brandId = req.query.brandId ? Number(req.query.brandId) : undefined;

    const rows = await db
      .select({
        productTitle: skus.productTitle,
        size: skus.size,
        qty: sql<string>`coalesce(sum(${inventoryLedger.delta}), 0)::text`,
      })
      .from(inventoryLedger)
      .innerJoin(skus, eq(skus.id, inventoryLedger.skuId))
      .innerJoin(brands, eq(brands.id, skus.brandId))
      .where(and(eq(brands.companyId, companyId), brandId ? eq(skus.brandId, brandId) : undefined))
      .groupBy(skus.productTitle, skus.size);

    const byProduct = new Map<string, number>();
    const bySize = new Map<string, number>();
    for (const r of rows) {
      const qty = Number(r.qty);
      byProduct.set(r.productTitle, (byProduct.get(r.productTitle) || 0) + qty);
      const sizeKey = r.size || "—";
      bySize.set(sizeKey, (bySize.get(sizeKey) || 0) + qty);
    }

    res.json({
      byProduct: Array.from(byProduct.entries()).map(([productTitle, qty]) => ({ productTitle, qty })).sort((a, b) => b.qty - a.qty),
      bySize: Array.from(bySize.entries()).map(([size, qty]) => ({ size, qty })),
    });
  } catch (err) {
    next(err);
  }
});
