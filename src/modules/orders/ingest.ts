import { and, eq } from "drizzle-orm";
import { db } from "../../db/client";
import { orders, orderItems, shipments, marketplaceSkuMap } from "../../db/schema";
import { NormalizedOrder } from "../../ingestion/types";
import { lockSkuWarehouse, reserveStock } from "../inventory/ledger";

export class UnmappedSkuError extends Error {
  constructor(marketplaceSku: string) {
    super(`No SKU mapping found for marketplace SKU "${marketplaceSku}" — fix the mapping and retry`);
  }
}

export interface IngestResult {
  orderId: number;
  created: boolean;
}

/**
 * Order creation and every line item's stock reservation happen in one
 * database transaction: a failed reservation (insufficient stock, or an
 * unmapped SKU) rolls back the *whole* order, so there is no path to an
 * order existing without a matching reservation for every item.
 *
 * Ingestion is idempotent on (marketplaceAccountId, marketplaceOrderId) —
 * re-running the same export a second time updates the existing order
 * instead of double-reserving stock.
 */
export async function ingestOrder(
  marketplaceAccountId: number,
  warehouseId: number,
  normalized: NormalizedOrder,
): Promise<IngestResult> {
  return db.transaction(async (tx) => {
    const [existing] = await tx
      .select({ id: orders.id })
      .from(orders)
      .where(and(eq(orders.marketplaceAccountId, marketplaceAccountId), eq(orders.marketplaceOrderId, normalized.marketplaceOrderId)))
      .limit(1);

    if (existing) {
      // Already ingested — status refresh only, no re-reservation.
      await tx
        .update(orders)
        .set({ status: normalized.status as any, verifiedAt: normalized.verifiedAt ?? null })
        .where(eq(orders.id, existing.id));
      return { orderId: existing.id, created: false };
    }

    const [order] = await tx
      .insert(orders)
      .values({
        marketplaceAccountId,
        marketplaceOrderId: normalized.marketplaceOrderId,
        status: normalized.status as any,
        fulfillmentType: normalized.fulfillmentType,
        invoiceNumber: normalized.invoiceNumber ?? null,
        invoiceDate: normalized.invoiceDate ?? null,
        orderedAt: normalized.orderedAt,
        verifiedAt: normalized.verifiedAt ?? null,
        rawPayload: normalized.rawPayload,
      })
      .returning({ id: orders.id });

    for (const item of normalized.items) {
      const [mapping] = await tx
        .select({ skuId: marketplaceSkuMap.skuId })
        .from(marketplaceSkuMap)
        .where(
          and(
            eq(marketplaceSkuMap.marketplaceAccountId, marketplaceAccountId),
            eq(marketplaceSkuMap.marketplaceSku, item.marketplaceSku),
          ),
        )
        .limit(1);

      if (!mapping) {
        throw new UnmappedSkuError(item.marketplaceSku);
      }

      await tx.insert(orderItems).values({
        orderId: order.id,
        skuId: mapping.skuId,
        marketplaceLineItemId: item.marketplaceLineItemId ?? null,
        marketplaceSku: item.marketplaceSku,
        productTitleSnapshot: item.productTitleSnapshot,
        variantSize: item.variantSize ?? null,
        quantity: item.quantity,
        unitPrice: item.unitPrice,
        mrp: item.mrp ?? null,
        shippingCharge: item.shippingCharge ?? "0",
        invoiceAmount: item.invoiceAmount ?? null,
        taxCgst: item.taxCgst ?? null,
        taxSgst: item.taxSgst ?? null,
        taxIgst: item.taxIgst ?? null,
        taxRate: item.taxRate ?? null,
        hsnCode: item.hsnCode ?? null,
        settlementPriceEstimate: item.settlementPriceEstimate ?? null,
      });

      // Advisory lock first, so the stock check below is serialized against
      // any other in-flight reservation for the same SKU in this warehouse.
      await lockSkuWarehouse(tx, mapping.skuId, warehouseId);
      await reserveStock(tx, {
        skuId: mapping.skuId,
        warehouseId,
        quantity: item.quantity,
        referenceType: "order",
        referenceId: String(order.id),
      });
    }

    if (normalized.shipment) {
      await tx.insert(shipments).values({
        orderId: order.id,
        warehouseId,
        ...normalized.shipment,
      });
    }

    return { orderId: order.id, created: true };
  });
}
