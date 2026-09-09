import { Router } from "express";
import { z } from "zod";
import { and, eq } from "drizzle-orm";
import { db } from "../db/client";
import { brands, marketplaceAccounts, marketplaceSkuMap, orderItems, orders, returns, skus } from "../db/schema";
import { requireAuth, requireCompanyScope } from "../middleware/auth";
import { requireSection } from "../security/permissions";
import { HttpError } from "../middleware/errorHandler";
import { lockSkuWarehouse, reserveStock } from "../modules/inventory/ledger";
import { UnmappedSkuError } from "../modules/orders/ingest";

export const entryRouter = Router();
entryRouter.use(requireAuth, requireCompanyScope);

/**
 * Single-entry forms (user request: "single entry karni padi order return
 * purchase bill") — one order or one return typed straight into the app,
 * flowing through exactly the same stock-ledger + idempotency machinery as
 * the CSV imports, so data stays interconnected (order ↔ sku ↔ store ↔ brand).
 */

async function accountInCompany(accountId: number, companyId: number) {
  const [acc] = await db
    .select({ id: marketplaceAccounts.id, isActive: marketplaceAccounts.isActive })
    .from(marketplaceAccounts)
    .innerJoin(brands, eq(brands.id, marketplaceAccounts.brandId))
    .where(and(eq(marketplaceAccounts.id, accountId), eq(brands.companyId, companyId)))
    .limit(1);
  if (!acc) throw new HttpError(403, "Seller account does not belong to your company");
  if (!acc.isActive) throw new HttpError(400, "This seller account is deactivated");
  return acc;
}

async function resolveSkuFromMapping(accountId: number, marketplaceSku: string) {
  const [map] = await db
    .select({ skuId: marketplaceSkuMap.skuId })
    .from(marketplaceSkuMap)
    .where(and(eq(marketplaceSkuMap.marketplaceAccountId, accountId), eq(marketplaceSkuMap.marketplaceSku, marketplaceSku)))
    .limit(1);
  if (!map) {
    // Self-code fallback: if the typed SKU exists as a code under any of the
    // company's brands, use it directly (matches the bulk auto-map behaviour).
    const [direct] = await db
      .select({ id: skus.id })
      .from(skus)
      .innerJoin(brands, eq(brands.id, skus.brandId))
      .where(and(eq(skus.code, marketplaceSku), eq(skus.isActive, true)))
      .limit(1);
    if (!direct) throw new UnmappedSkuError(marketplaceSku);
    return direct.id;
  }
  return map.skuId;
}

const orderSchema = z.object({
  marketplaceAccountId: z.number().int().positive(),
  warehouseId: z.number().int().positive(),
  marketplaceOrderId: z.string().trim().min(3).max(100),
  marketplaceSku: z.string().trim().min(1).max(200),
  quantity: z.number().int().positive().max(999).default(1),
  size: z.string().trim().max(20).optional(),
  unitPrice: z.string().regex(/^\d+(\.\d{1,2})?$/),
  invoiceAmount: z.string().regex(/^\d+(\.\d{1,2})?$/).optional(),
  orderedAt: z.string().datetime().optional(),
  customerName: z.string().trim().max(150).optional(),
  customerCity: z.string().trim().max(100).optional(),
  awb: z.string().trim().max(100).optional(),
  courier: z.string().trim().max(100).optional(),
});

entryRouter.post("/order", requireSection("orders"), async (req, res, next) => {
  try {
    const body = orderSchema.parse(req.body);
    await accountInCompany(body.marketplaceAccountId, req.session!.companyId);

    const skuId = await resolveSkuFromMapping(body.marketplaceAccountId, body.marketplaceSku);
    const [sku] = await db.select().from(skus).where(eq(skus.id, skuId)).limit(1);

    const result = await db.transaction(async (tx) => {
      const [dupe] = await tx
        .select({ id: orders.id })
        .from(orders)
        .where(and(eq(orders.marketplaceAccountId, body.marketplaceAccountId), eq(orders.marketplaceOrderId, body.marketplaceOrderId)))
        .limit(1);
      if (dupe) throw new HttpError(409, "An order with this ID already exists for this store");

      const [order] = await tx
        .insert(orders)
        .values({
          marketplaceAccountId: body.marketplaceAccountId,
          marketplaceOrderId: body.marketplaceOrderId,
          status: "CREATED",
          fulfillmentType: "SELLER_FULFILLED",
          orderedAt: body.orderedAt ? new Date(body.orderedAt) : new Date(),
          rawPayload: { source: "MANUAL_ENTRY", customerName: body.customerName ?? null, customerCity: body.customerCity ?? null, courier: body.courier ?? null },
        })
        .returning({ id: orders.id });

      await tx.insert(orderItems).values({
        orderId: order.id,
        skuId,
        marketplaceSku: body.marketplaceSku,
        productTitleSnapshot: sku?.productTitle ?? body.marketplaceSku,
        variantSize: body.size ?? sku?.size ?? null,
        quantity: body.quantity,
        unitPrice: body.unitPrice,
        invoiceAmount: body.invoiceAmount ?? body.unitPrice,
      });

      await lockSkuWarehouse(tx, skuId, body.warehouseId);
      await reserveStock(tx, {
        skuId,
        warehouseId: body.warehouseId,
        quantity: body.quantity,
        referenceType: "manual_entry",
        referenceId: String(order.id),
      });

      return order.id;
    });

    res.status(201).json({ orderId: result, skuId });
  } catch (err) {
    next(err);
  }
});

const returnSchema = z.object({
  marketplaceOrderId: z.string().trim().min(3).max(100),
  marketplaceAccountId: z.number().int().positive().optional(),
  reverseAwb: z.string().trim().max(100).optional(),
  reverseCarrier: z.string().trim().max(100).optional(),
  notes: z.string().trim().max(300).optional(),
});

entryRouter.post("/return", requireSection("returns"), async (req, res, next) => {
  try {
    const body = returnSchema.parse(req.body);

    const candidates = await db
      .select({ id: orders.id, accountId: orders.marketplaceAccountId })
      .from(orders)
      .innerJoin(marketplaceAccounts, eq(marketplaceAccounts.id, orders.marketplaceAccountId))
      .innerJoin(brands, eq(brands.id, marketplaceAccounts.brandId))
      .where(and(eq(orders.marketplaceOrderId, body.marketplaceOrderId), eq(brands.companyId, req.session!.companyId)))
      .limit(2);

    const order = body.marketplaceAccountId
      ? candidates.find((c) => c.accountId === body.marketplaceAccountId)
      : candidates[0];
    if (!order) throw new HttpError(404, "Order not found in your workspace — check the order ID (and store, if given)");

    const [dupe] = await db.select({ id: returns.id }).from(returns).where(eq(returns.orderId, order.id)).limit(1);
    if (dupe) throw new HttpError(409, "A return already exists for this order");

    const [row] = await db
      .insert(returns)
      .values({
        orderId: order.id,
        status: "INITIATED",
        reverseAwb: body.reverseAwb ?? null,
        reverseCarrier: body.reverseCarrier ?? null,
        initiatedAt: new Date(),
        qcNotes: body.notes ?? null,
      })
      .returning({ id: returns.id });
    res.status(201).json({ returnId: row.id, orderId: order.id });
  } catch (err) {
    next(err);
  }
});

/** Return receive — mark a return physically received (same as scan, by order ID). */
entryRouter.post("/return/:id/receive", requireSection("returns"), async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    const [ret] = await db
      .select({ id: returns.id, status: returns.status, orderId: returns.orderId })
      .from(returns)
      .innerJoin(orders, eq(orders.id, returns.orderId))
      .innerJoin(marketplaceAccounts, eq(marketplaceAccounts.id, orders.marketplaceAccountId))
      .innerJoin(brands, eq(brands.id, marketplaceAccounts.brandId))
      .where(and(eq(returns.id, id), eq(brands.companyId, req.session!.companyId)))
      .limit(1);
    if (!ret) throw new HttpError(404, "Return not found");
    if (ret.status === "RECEIVED" || ret.status === "RESTOCKED" || ret.status === "CLOSED") {
      throw new HttpError(409, "Return already received");
    }
    await db.update(returns).set({ status: "RECEIVED", deliveredAt: new Date() }).where(eq(returns.id, id));
    res.status(204).end();
  } catch (err) {
    next(err);
  }
});
