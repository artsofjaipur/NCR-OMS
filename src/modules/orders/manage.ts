import { and, eq } from "drizzle-orm";
import { db } from "../../db/client";
import { orders, orderItems, shipments, returns, inventoryLedger, marketplaceAccounts, brands } from "../../db/schema";
import { HttpError } from "../../middleware/errorHandler";

export class OrderNotFoundError extends Error {
  constructor(orderId: number) {
    super(`Order ${orderId} not found`);
  }
}

/**
 * Every order route re-derives the order's company from its marketplace
 * account/brand chain and checks it against the caller's session — same
 * scoping rule every other route in this app uses, so an OWNER at one
 * company can never read/edit/delete another company's order by guessing an
 * id.
 */
export async function assertOrderInCompany(orderId: number, companyId: number): Promise<void> {
  const [row] = await db
    .select({ companyId: brands.companyId })
    .from(orders)
    .innerJoin(marketplaceAccounts, eq(marketplaceAccounts.id, orders.marketplaceAccountId))
    .innerJoin(brands, eq(brands.id, marketplaceAccounts.brandId))
    .where(eq(orders.id, orderId))
    .limit(1);
  if (!row) throw new OrderNotFoundError(orderId);
  if (row.companyId !== companyId) throw new HttpError(403, "Order does not belong to your company");
}

export async function getOrderDetail(orderId: number) {
  const [order] = await db.select().from(orders).where(eq(orders.id, orderId)).limit(1);
  if (!order) throw new OrderNotFoundError(orderId);
  const items = await db.select().from(orderItems).where(eq(orderItems.orderId, orderId));
  const shipmentRows = await db.select().from(shipments).where(eq(shipments.orderId, orderId));
  const returnRows = await db.select().from(returns).where(eq(returns.orderId, orderId));
  return { order, items, shipment: shipmentRows[0] ?? null, returns: returnRows };
}

export interface OrderPatch {
  status?: "CREATED" | "READY_TO_DISPATCH" | "DISPATCHED" | "DELIVERED" | "CANCELLED" | "RTO_INITIATED" | "ON_HOLD";
  fulfillmentType?: "SELLER_FULFILLED" | "MARKETPLACE_FULFILLED";
  invoiceNumber?: string | null;
  invoiceDate?: string | null;
  orderedAt?: string;
  verifiedAt?: string | null;
  holdReason?: string | null;
  holdDate?: string | null;
  shipment?: {
    awbNumber?: string | null;
    carrier?: string | null;
    trackingUrl?: string | null;
    serviceLevel?: string | null;
    shippedAt?: string | null;
    deliveredAt?: string | null;
  };
  items?: {
    id: number;
    quantity?: number;
    unitPrice?: string;
    marketplaceSku?: string;
    productTitleSnapshot?: string;
  }[];
}

/**
 * Edits an order in place. Flipping status to CANCELLED releases any stock
 * this order had reserved (ORDER_RESERVED ledger rows for it) back into the
 * ledger as ORDER_CANCELLED — otherwise a cancelled order would leave its
 * units permanently "reserved" and unsellable. Bulk-imported historical
 * orders never wrote a reservation in the first place (see the 2026-09
 * order-history import — deliberately skipped, see project notes), so this
 * is a safe no-op for them.
 */
export async function updateOrder(orderId: number, patch: OrderPatch) {
  await db.transaction(async (tx) => {
    const [existing] = await tx.select().from(orders).where(eq(orders.id, orderId)).limit(1);
    if (!existing) throw new OrderNotFoundError(orderId);

    const orderSet: Record<string, unknown> = {};
    if (patch.status !== undefined) orderSet.status = patch.status;
    if (patch.fulfillmentType !== undefined) orderSet.fulfillmentType = patch.fulfillmentType;
    if (patch.invoiceNumber !== undefined) orderSet.invoiceNumber = patch.invoiceNumber;
    if (patch.invoiceDate !== undefined) orderSet.invoiceDate = patch.invoiceDate ? new Date(patch.invoiceDate) : null;
    if (patch.orderedAt !== undefined) orderSet.orderedAt = new Date(patch.orderedAt);
    if (patch.verifiedAt !== undefined) orderSet.verifiedAt = patch.verifiedAt ? new Date(patch.verifiedAt) : null;
    if (patch.holdReason !== undefined) orderSet.holdReason = patch.holdReason;
    if (patch.holdDate !== undefined) orderSet.holdDate = patch.holdDate ? new Date(patch.holdDate) : null;

    if (patch.status === "CANCELLED" && existing.status !== "CANCELLED") {
      const reservations = await tx
        .select()
        .from(inventoryLedger)
        .where(
          and(
            eq(inventoryLedger.referenceType, "order"),
            eq(inventoryLedger.referenceId, String(orderId)),
            eq(inventoryLedger.reason, "ORDER_RESERVED"),
          ),
        );
      for (const r of reservations) {
        await tx.insert(inventoryLedger).values({
          skuId: r.skuId,
          warehouseId: r.warehouseId,
          delta: -r.delta, // the reservation's delta is negative; releasing it back is the positive mirror
          reason: "ORDER_CANCELLED",
          referenceType: "order",
          referenceId: String(orderId),
        });
      }
    }

    if (Object.keys(orderSet).length > 0) {
      await tx.update(orders).set(orderSet).where(eq(orders.id, orderId));
    }

    if (patch.shipment) {
      const [existingShipment] = await tx.select({ id: shipments.id }).from(shipments).where(eq(shipments.orderId, orderId)).limit(1);
      const s = patch.shipment;
      const shipSet: Record<string, unknown> = {};
      if (s.awbNumber !== undefined) shipSet.awbNumber = s.awbNumber;
      if (s.carrier !== undefined) shipSet.carrier = s.carrier;
      if (s.trackingUrl !== undefined) shipSet.trackingUrl = s.trackingUrl;
      if (s.serviceLevel !== undefined) shipSet.serviceLevel = s.serviceLevel;
      if (s.shippedAt !== undefined) shipSet.shippedAt = s.shippedAt ? new Date(s.shippedAt) : null;
      if (s.deliveredAt !== undefined) shipSet.deliveredAt = s.deliveredAt ? new Date(s.deliveredAt) : null;
      if (existingShipment && Object.keys(shipSet).length > 0) {
        await tx.update(shipments).set(shipSet).where(eq(shipments.id, existingShipment.id));
      }
    }

    if (patch.items) {
      for (const item of patch.items) {
        const itemSet: Record<string, unknown> = {};
        if (item.quantity !== undefined) itemSet.quantity = item.quantity;
        if (item.unitPrice !== undefined) itemSet.unitPrice = item.unitPrice;
        if (item.marketplaceSku !== undefined) itemSet.marketplaceSku = item.marketplaceSku;
        if (item.productTitleSnapshot !== undefined) itemSet.productTitleSnapshot = item.productTitleSnapshot;
        if (Object.keys(itemSet).length > 0) {
          await tx.update(orderItems).set(itemSet).where(and(eq(orderItems.id, item.id), eq(orderItems.orderId, orderId)));
        }
      }
    }
  });

  return getOrderDetail(orderId);
}

/**
 * Deletes an order and everything under it (order_items/shipments/returns
 * cascade at the DB level). Releases any reserved stock first, same as a
 * cancel, so a delete can never leave units silently locked up forever.
 */
export async function deleteOrder(orderId: number): Promise<void> {
  await db.transaction(async (tx) => {
    const [existing] = await tx.select({ id: orders.id }).from(orders).where(eq(orders.id, orderId)).limit(1);
    if (!existing) throw new OrderNotFoundError(orderId);

    const reservations = await tx
      .select()
      .from(inventoryLedger)
      .where(
        and(
          eq(inventoryLedger.referenceType, "order"),
          eq(inventoryLedger.referenceId, String(orderId)),
          eq(inventoryLedger.reason, "ORDER_RESERVED"),
        ),
      );
    for (const r of reservations) {
      await tx.insert(inventoryLedger).values({
        skuId: r.skuId,
        warehouseId: r.warehouseId,
        delta: -r.delta,
        reason: "ORDER_CANCELLED",
        referenceType: "order",
        referenceId: String(orderId),
      });
    }

    await tx.delete(orders).where(eq(orders.id, orderId));
  });
}
