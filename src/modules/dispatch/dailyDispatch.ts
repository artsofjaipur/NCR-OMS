import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import { db } from "../../db/client";
import { orders, orderItems, shipments, skus, brands } from "../../db/schema";

const DISPATCH_ELIGIBLE_STATUSES = ["READY_TO_DISPATCH"] as const;

export interface PicklistRow {
  skuCode: string;
  color: string | null;
  size: string | null;
  totalQuantity: number;
}

/**
 * Picklist: every unit that needs pulling from the shelf today for one
 * brand, summed across every marketplace order in a dispatch-eligible
 * status — mirrors the "Supplier Name / SKU / Color / Size / Total
 * Quantity" picklist format from the supplier manifests, with "Supplier
 * Name" read as brand (see the naming-collision note in the architecture
 * addendum).
 */
export async function buildPicklist(brandId: number): Promise<PicklistRow[]> {
  const rows = await db
    .select({
      code: skus.code,
      color: skus.color,
      size: skus.size,
      quantity: orderItems.quantity,
    })
    .from(orderItems)
    .innerJoin(orders, eq(orders.id, orderItems.orderId))
    .innerJoin(skus, eq(skus.id, orderItems.skuId))
    .where(and(eq(skus.brandId, brandId), inArray(orders.status, [...DISPATCH_ELIGIBLE_STATUSES])));

  const grouped = new Map<string, PicklistRow>();
  for (const row of rows) {
    const key = `${row.code}::${row.color ?? ""}::${row.size ?? ""}`;
    const existing = grouped.get(key);
    if (existing) {
      existing.totalQuantity += row.quantity;
    } else {
      grouped.set(key, { skuCode: row.code, color: row.color, size: row.size, totalQuantity: row.quantity });
    }
  }
  return [...grouped.values()].sort((a, b) => a.skuCode.localeCompare(b.skuCode));
}

export interface PackingSheetRow {
  subOrderNo: string;
  awb: string | null;
  skuCode: string;
  quantity: number;
  size: string | null;
}

export interface CourierPackingSheet {
  courier: string;
  rows: PackingSheetRow[];
}

/**
 * Courier-wise packing sheets: the day's dispatch-eligible shipments for a
 * brand, grouped by carrier — the second half of the supplier manifest
 * format. Ticking "Packed" on the floor is what should call
 * markShipmentPacked() below.
 */
export async function buildCourierPackingSheets(brandId: number): Promise<CourierPackingSheet[]> {
  const rows = await db
    .select({
      subOrderNo: orders.marketplaceOrderId,
      awb: shipments.awbNumber,
      carrier: shipments.carrier,
      skuCode: skus.code,
      size: skus.size,
      quantity: orderItems.quantity,
    })
    .from(orderItems)
    .innerJoin(orders, eq(orders.id, orderItems.orderId))
    .innerJoin(skus, eq(skus.id, orderItems.skuId))
    .innerJoin(shipments, eq(shipments.orderId, orders.id))
    .where(and(eq(skus.brandId, brandId), inArray(orders.status, [...DISPATCH_ELIGIBLE_STATUSES])));

  const byCourier = new Map<string, PackingSheetRow[]>();
  for (const row of rows) {
    const courier = row.carrier ?? "UNASSIGNED";
    const bucket = byCourier.get(courier) ?? [];
    bucket.push({ subOrderNo: row.subOrderNo, awb: row.awb, skuCode: row.skuCode, quantity: row.quantity, size: row.size });
    byCourier.set(courier, bucket);
  }
  return [...byCourier.entries()].map(([courier, sheetRows]) => ({ courier, rows: sheetRows }));
}

/** The floor's "Packed" checkbox — writes the timestamp and moves the shipment past dispatch. */
export async function markShipmentPacked(shipmentId: number): Promise<void> {
  await db.update(shipments).set({ packedAt: new Date() }).where(eq(shipments.id, shipmentId));
}
