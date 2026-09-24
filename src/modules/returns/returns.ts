import { and, eq, ne } from "drizzle-orm";
import { db } from "../../db/client";
import { returns, orderItems, orders } from "../../db/schema";
import { lockSkuWarehouse, receiveStock } from "../inventory/ledger";

/**
 * Return: the marketplace-reported lifecycle, from initiation to reverse-AWB
 * delivery at the warehouse door.
 *
 * Auto-syncs the order itself when the return is a genuine RTO (the parcel
 * never reached the customer) -- flips orders.status to RTO_INITIATED so the
 * dashboard/orders list reflects it immediately, without anyone having to
 * open the order and set it by hand. A CUSTOMER_RETURN (the order was
 * delivered, then came back) deliberately does NOT touch orders.status --
 * that order genuinely was delivered, so its own status field should stay
 * DELIVERED; the return's own status (visible on the orders list as a
 * separate "Return" badge, and in full on the order detail) is what tracks
 * "return upcoming" / "return received" for that case. CANCELLED orders are
 * never overwritten either way.
 */
export async function initiateReturn(params: {
  orderId: number;
  orderItemId?: number | null;
  reverseAwb?: string | null;
  reverseCarrier?: string | null;
  returnType?: string | null;
  reason?: string | null;
  initiatedAt: Date;
}): Promise<{ returnId: number }> {
  const [row] = await db
    .insert(returns)
    .values({
      orderId: params.orderId,
      orderItemId: params.orderItemId ?? null,
      status: "INITIATED",
      reverseAwb: params.reverseAwb ?? null,
      reverseCarrier: params.reverseCarrier ?? null,
      returnType: params.returnType ?? null,
      reason: params.reason ?? null,
      initiatedAt: params.initiatedAt,
    })
    .returning({ id: returns.id });

  if (params.returnType === "RTO") {
    await db
      .update(orders)
      .set({ status: "RTO_INITIATED" })
      .where(and(eq(orders.id, params.orderId), ne(orders.status, "CANCELLED")));
  }

  return { returnId: row.id };
}

/**
 * Return Received: the warehouse-confirmation stage, split out from Return
 * on purpose. A marketplace can report a return as "delivered" days before
 * anyone on the floor has actually opened the box — this is that separate,
 * physical checkpoint.
 */
export async function markReturnReceived(returnId: number, deliveredAt: Date): Promise<void> {
  await db.update(returns).set({ status: "RECEIVED", deliveredAt }).where(eq(returns.id, returnId));
}

export async function recordQcResult(returnId: number, passed: boolean, notes?: string | null): Promise<void> {
  await db
    .update(returns)
    .set({ status: passed ? "QC_PASSED" : "QC_FAILED", qcNotes: notes ?? null })
    .where(eq(returns.id, returnId));
}

/** Restocks a QC-passed return back into sellable inventory. */
export async function restockReturn(returnId: number, warehouseId: number): Promise<void> {
  await db.transaction(async (tx) => {
    const [ret] = await tx.select().from(returns).where(eq(returns.id, returnId)).limit(1);
    if (!ret) throw new Error(`Return ${returnId} not found`);
    if (ret.status !== "QC_PASSED") throw new Error(`Return ${returnId} must be QC_PASSED before restocking (is ${ret.status})`);
    if (!ret.orderItemId) throw new Error(`Return ${returnId} has no order item to restock`);

    const [item] = await tx.select().from(orderItems).where(eq(orderItems.id, ret.orderItemId)).limit(1);
    if (!item?.skuId) throw new Error(`Order item ${ret.orderItemId} has no resolved SKU to restock`);

    await lockSkuWarehouse(tx, item.skuId, warehouseId);
    await receiveStock(tx, {
      skuId: item.skuId,
      warehouseId,
      quantity: item.quantity,
      reason: "RETURN_RESTOCK",
      referenceType: "return",
      referenceId: String(returnId),
    });

    await tx.update(returns).set({ status: "RESTOCKED", restockedAt: new Date() }).where(eq(returns.id, returnId));
  });
}
