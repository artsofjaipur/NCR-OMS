import { Router } from "express";
import { z } from "zod";
import { desc, eq, inArray, sql } from "drizzle-orm";
import { db } from "../db/client";
import { orders, marketplaceAccounts, brands, shipments } from "../db/schema";
import { requireAuth, requireCompanyScope, requireRole } from "../middleware/auth";
import { requireSection } from "../security/permissions";
import { HttpError } from "../middleware/errorHandler";
import { parseFlipkartExport } from "../ingestion/parsers/flipkart";
import { parseMeeshoExport } from "../ingestion/parsers/meesho";
import { parseSnapdealExport } from "../ingestion/parsers/snapdeal";
import { ingestOrder, UnmappedSkuError } from "../modules/orders/ingest";
import { InsufficientStockError } from "../modules/inventory/ledger";
import { assertOrderInCompany, getOrderDetail, updateOrder, deleteOrder, OrderNotFoundError } from "../modules/orders/manage";

export const ordersRouter = Router();
ordersRouter.use(requireAuth, requireCompanyScope, requireSection("orders"));

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

    // Default stays 200 (unchanged for the dashboard's "recent orders"
    // widget); a real Orders page can ask for more with ?limit=&offset=.
    const limit = Math.min(Math.max(Number(req.query.limit) || 200, 1), 2000);
    const offset = Math.max(Number(req.query.offset) || 0, 0);

    // SKU(s) and AWB come along inline (a correlated subquery for the SKU
    // list, a left join for the one shipment row an order has) so the list
    // view already shows order no / SKU / AWB / status linked together,
    // without a click-through per row.
    const rows = accountIds.length
      ? await db
          .select({
            id: orders.id,
            marketplaceAccountId: orders.marketplaceAccountId,
            marketplaceOrderId: orders.marketplaceOrderId,
            status: orders.status,
            fulfillmentType: orders.fulfillmentType,
            invoiceNumber: orders.invoiceNumber,
            orderedAt: orders.orderedAt,
            holdReason: orders.holdReason,
            awbNumber: shipments.awbNumber,
            skuSummary: sql<string>`(SELECT string_agg(DISTINCT oi.marketplace_sku, ', ') FROM order_items oi WHERE oi.order_id = ${orders.id})`,
            // The order's own status field doesn't change just because a
            // return exists (a DELIVERED order that comes back is still
            // "DELIVERED" as far as the marketplace's own lifecycle goes) --
            // so the list surfaces the *latest* return's status/type inline,
            // the same way SKU/AWB are already inlined, instead of making
            // people click into every order to see "return upcoming" /
            // "return received".
            returnStatus: sql<string>`(SELECT r.status FROM returns r WHERE r.order_id = ${orders.id} ORDER BY r.created_at DESC LIMIT 1)`,
            returnType: sql<string>`(SELECT r.return_type FROM returns r WHERE r.order_id = ${orders.id} ORDER BY r.created_at DESC LIMIT 1)`,
          })
          .from(orders)
          .leftJoin(shipments, eq(shipments.orderId, orders.id))
          .where(inArray(orders.marketplaceAccountId, accountIds.map((a) => a.id)))
          .orderBy(desc(orders.orderedAt))
          .limit(limit)
          .offset(offset)
      : [];
    res.json(rows);
  } catch (err) {
    next(err);
  }
});

/** Total order count for this company — pairs with GET / for pagination UI. */
ordersRouter.get("/count", async (req, res, next) => {
  try {
    const accountIds = await db
      .select({ id: marketplaceAccounts.id })
      .from(marketplaceAccounts)
      .innerJoin(brands, eq(brands.id, marketplaceAccounts.brandId))
      .where(eq(brands.companyId, req.session!.companyId));

    if (!accountIds.length) return res.json({ total: 0 });

    const [row] = await db
      .select({ total: sql<number>`count(*)::int` })
      .from(orders)
      .where(inArray(orders.marketplaceAccountId, accountIds.map((a) => a.id)));
    res.json({ total: row?.total ?? 0 });
  } catch (err) {
    next(err);
  }
});

/** Full detail for one order — the fields, its line items, its shipment, its return history. */
ordersRouter.get("/:id", async (req, res, next) => {
  try {
    const orderId = Number(req.params.id);
    if (!Number.isInteger(orderId) || orderId <= 0) throw new HttpError(400, "Invalid order id");
    await assertOrderInCompany(orderId, req.session!.companyId);
    res.json(await getOrderDetail(orderId));
  } catch (err) {
    if (err instanceof OrderNotFoundError) return next(new HttpError(404, err.message));
    next(err);
  }
});

const orderPatchSchema = z.object({
  status: z.enum(["CREATED", "READY_TO_DISPATCH", "DISPATCHED", "DELIVERED", "CANCELLED", "RTO_INITIATED", "ON_HOLD"]).optional(),
  fulfillmentType: z.enum(["SELLER_FULFILLED", "MARKETPLACE_FULFILLED"]).optional(),
  invoiceNumber: z.string().max(60).nullable().optional(),
  invoiceDate: z.string().nullable().optional(),
  orderedAt: z.string().optional(),
  verifiedAt: z.string().nullable().optional(),
  holdReason: z.string().nullable().optional(),
  holdDate: z.string().nullable().optional(),
  shipment: z
    .object({
      awbNumber: z.string().max(100).nullable().optional(),
      carrier: z.string().max(100).nullable().optional(),
      trackingUrl: z.string().nullable().optional(),
      serviceLevel: z.string().max(30).nullable().optional(),
      shippedAt: z.string().nullable().optional(),
      deliveredAt: z.string().nullable().optional(),
    })
    .optional(),
  items: z
    .array(
      z.object({
        id: z.number().int().positive(),
        quantity: z.number().int().positive().optional(),
        unitPrice: z.string().optional(),
        marketplaceSku: z.string().max(200).optional(),
        productTitleSnapshot: z.string().max(300).optional(),
      }),
    )
    .optional(),
});

/**
 * Edits an order — status, invoice/verification dates, hold reason, AWB/
 * carrier, and per-line quantity/price/SKU-code corrections. Every field is
 * optional; only what's sent gets changed. Cancelling releases any stock
 * this order had reserved (see modules/orders/manage.ts).
 */
ordersRouter.patch("/:id", async (req, res, next) => {
  try {
    const orderId = Number(req.params.id);
    if (!Number.isInteger(orderId) || orderId <= 0) throw new HttpError(400, "Invalid order id");
    await assertOrderInCompany(orderId, req.session!.companyId);
    const patch = orderPatchSchema.parse(req.body);
    res.json(await updateOrder(orderId, patch));
  } catch (err) {
    if (err instanceof OrderNotFoundError) return next(new HttpError(404, err.message));
    next(err);
  }
});

/** Deletes an order (and its items/shipment/returns, cascaded) — OWNER/ADMIN only. */
ordersRouter.delete("/:id", requireRole("OWNER", "ADMIN"), async (req, res, next) => {
  try {
    const orderId = Number(req.params.id);
    if (!Number.isInteger(orderId) || orderId <= 0) throw new HttpError(400, "Invalid order id");
    await assertOrderInCompany(orderId, req.session!.companyId);
    await deleteOrder(orderId);
    res.status(204).end();
  } catch (err) {
    if (err instanceof OrderNotFoundError) return next(new HttpError(404, err.message));
    next(err);
  }
});
