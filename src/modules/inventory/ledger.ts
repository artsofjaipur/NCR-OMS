import { sql, eq, and } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import * as schema from "../../db/schema";
import { inventoryLedger } from "../../db/schema";

export class InsufficientStockError extends Error {
  constructor(skuId: number, warehouseId: number, requested: number, available: number) {
    super(`Insufficient stock for SKU ${skuId} in warehouse ${warehouseId}: requested ${requested}, available ${available}`);
  }
}

type Tx = NodePgDatabase<typeof schema>;

/**
 * Current stock for a SKU/warehouse is always SUM(delta) over the
 * append-only ledger — never a mutable counter. Must be called from inside
 * the same transaction as the advisory lock below, or the read is not
 * serialized against concurrent writers.
 */
export async function getCurrentStock(tx: Tx, skuId: number, warehouseId: number): Promise<number> {
  const [row] = await tx
    .select({ total: sql<string>`COALESCE(SUM(${inventoryLedger.delta}), 0)` })
    .from(inventoryLedger)
    .where(and(eq(inventoryLedger.skuId, skuId), eq(inventoryLedger.warehouseId, warehouseId)));
  return Number(row?.total ?? 0);
}

/**
 * Serializes all ledger writes for one (sku, warehouse) pair using a
 * Postgres transaction-scoped advisory lock — it auto-releases at commit or
 * rollback, so a crashed request can never leave the pair stuck locked.
 * Call this before reading current stock so the read-then-write is atomic
 * against concurrent reservations for the same SKU.
 */
export async function lockSkuWarehouse(tx: Tx, skuId: number, warehouseId: number): Promise<void> {
  await tx.execute(sql`SELECT pg_advisory_xact_lock(${skuId}, ${warehouseId})`);
}

/**
 * Reserves stock for an order line, blocked at the write if it would
 * oversell -- unless `strict: false` is passed, in which case the
 * reservation is written anyway (stock can go negative) and the shortfall
 * is returned instead of thrown.
 *
 * `strict: false` exists because this app's stock ledger starts truly
 * empty: the 2026-07 historical order-history bulk import deliberately
 * skipped writing ORDER_RESERVED rows for orders that were already
 * dispatched off-system (see BRAIN.md), so `getCurrentStock` reads 0 for
 * every SKU until someone records a real Stock In. Blocking brand-new
 * marketplace orders on that -- rejecting an order Meesho/Snapdeal/Flipkart
 * already confirmed and already shipped, just because this app hasn't been
 * told the physical stock count yet -- would make CSV upload permanently
 * broken for every company on this platform until they've done a full
 * manual stock reconciliation. Going negative here is the honest signal
 * that a stock-in is overdue for that SKU, surfaced back to the caller
 * (see `shortfall` below) rather than hidden -- it does not silently
 * pretend the stock exists.
 *
 * Caller must already hold the advisory lock for this (skuId, warehouseId)
 * pair within the current transaction.
 */
export async function reserveStock(
  tx: Tx,
  params: { skuId: number; warehouseId: number; quantity: number; referenceType: string; referenceId: string },
  opts: { strict?: boolean } = {},
): Promise<{ shortfall: number }> {
  const strict = opts.strict ?? true;
  const available = await getCurrentStock(tx, params.skuId, params.warehouseId);
  const shortfall = Math.max(0, params.quantity - available);
  if (shortfall > 0 && strict) {
    throw new InsufficientStockError(params.skuId, params.warehouseId, params.quantity, available);
  }
  await tx.insert(inventoryLedger).values({
    skuId: params.skuId,
    warehouseId: params.warehouseId,
    delta: -params.quantity,
    reason: "ORDER_RESERVED",
    referenceType: params.referenceType,
    referenceId: params.referenceId,
  });
  return { shortfall };
}

export async function receiveStock(
  tx: Tx,
  params: { skuId: number; warehouseId: number; quantity: number; reason: "PURCHASE_RECEIPT" | "RETURN_RESTOCK" | "MANUAL_ADJUSTMENT"; referenceType: string; referenceId: string },
): Promise<void> {
  await tx.insert(inventoryLedger).values({
    skuId: params.skuId,
    warehouseId: params.warehouseId,
    delta: params.quantity,
    reason: params.reason,
    referenceType: params.referenceType,
    referenceId: params.referenceId,
  });
}
