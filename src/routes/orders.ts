import { Router } from "express";
import { z } from "zod";
import { desc, eq, inArray } from "drizzle-orm";
import { db } from "../db/client";
import { orders, marketplaceAccounts, brands } from "../db/schema";
import { requireAuth, requireCompanyScope } from "../middleware/auth";
import { HttpError } from "../middleware/errorHandler";
import { parseFlipkartExport } from "../ingestion/parsers/flipkart";
import { parseMeeshoExport } from "../ingestion/parsers/meesho";
import { parseSnapdealExport } from "../ingestion/parsers/snapdeal";
import { ingestOrder, UnmappedSkuError } from "../modules/orders/ingest";
import { InsufficientStockError } from "../modules/inventory/ledger";

export const ordersRouter = Router();
ordersRouter.use(requireAuth, requireCompanyScope);

const PARSERS = {
  flipkart: parseFlipkartExport,
  meesho: parseMeeshoExport,
  snapdeal: parseSnapdealExport,
} as const;

const importSchema = z.object({
  marketplaceAccountId: z.number().int().positive(),
  warehouseId: z.number().int().positive(),
  csv: z.string().min(1),
});

/**
 * Accepts a raw CSV export from one of the three marketplaces we have real
 * sample data for and ingests every order in it. Each order ingests in its
 * own transaction (see modules/orders/ingest.ts) — one bad row doesn't sink
 * the whole file, it's reported back per order instead.
 */
ordersRouter.post("/import/:marketplace", async (req, res, next) => {
  try {
    const marketplace = req.params.marketplace as keyof typeof PARSERS;
    const parser = PARSERS[marketplace];
    if (!parser) {
      throw new HttpError(400, `No parser for marketplace "${req.params.marketplace}" — supported: ${Object.keys(PARSERS).join(", ")}`);
    }
    const body = importSchema.parse(req.body);

    const [account] = await db
      .select({ id: marketplaceAccounts.id, brandId: marketplaceAccounts.brandId })
      .from(marketplaceAccounts)
      .where(eq(marketplaceAccounts.id, body.marketplaceAccountId))
      .limit(1);
    if (!account) throw new HttpError(404, "Marketplace account not found");
    const [brand] = await db.select({ companyId: brands.companyId }).from(brands).where(eq(brands.id, account.brandId)).limit(1);
    if (!brand || brand.companyId !== req.session!.companyId) {
      throw new HttpError(403, "Marketplace account does not belong to your company");
    }

    const normalizedOrders = parser(body.csv);
    const results: { marketplaceOrderId: string; orderId?: number; created?: boolean; error?: string }[] = [];

    for (const normalized of normalizedOrders) {
      try {
        const result = await ingestOrder(body.marketplaceAccountId, body.warehouseId, normalized);
        results.push({ marketplaceOrderId: normalized.marketplaceOrderId, orderId: result.orderId, created: result.created });
      } catch (err) {
        const message =
          err instanceof UnmappedSkuError || err instanceof InsufficientStockError ? err.message : "Ingestion failed for this order";
        results.push({ marketplaceOrderId: normalized.marketplaceOrderId, error: message });
      }
    }

    res.status(207).json({ imported: results.filter((r) => r.orderId).length, failed: results.filter((r) => r.error).length, results });
  } catch (err) {
    next(err);
  }
});

ordersRouter.get("/", async (req, res, next) => {
  try {
    const accountIds = await db
      .select({ id: marketplaceAccounts.id })
      .from(marketplaceAccounts)
      .innerJoin(brands, eq(brands.id, marketplaceAccounts.brandId))
      .where(eq(brands.companyId, req.session!.companyId));

    const rows = accountIds.length
      ? await db
          .select()
          .from(orders)
          .where(inArray(orders.marketplaceAccountId, accountIds.map((a) => a.id)))
          .orderBy(desc(orders.orderedAt))
          .limit(200)
      : [];
    res.json(rows);
  } catch (err) {
    next(err);
  }
});
