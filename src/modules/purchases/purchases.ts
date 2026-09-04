import { db } from "../../db/client";
import { purchaseEntries, purchaseEntryItems } from "../../db/schema";
import { lockSkuWarehouse, receiveStock } from "../inventory/ledger";

export interface PurchaseEntryInput {
  companyId: number;
  warehouseId: number;
  supplierId?: number | null;
  source: "PURCHASE_ORDER" | "DIRECT_ADJUSTMENT";
  poReference?: string | null;
  supplierInvoiceNumber?: string | null;
  invoiceDate?: Date | null;
  adjustmentReason?: string | null;
  createdByUserId?: number | null;
  items: { skuId: number; quantity: number; unitCost: string }[];
}

/**
 * Purchase Entry covers both paths the module name implies: a PO-backed
 * goods receipt (source = PURCHASE_ORDER, with a supplier + invoice) and a
 * direct stock correction with no paper trail beyond a typed reason
 * (source = DIRECT_ADJUSTMENT). Both land in the same inventory ledger as a
 * positive delta, tagged back to this purchase entry as the reference.
 */
export async function recordPurchaseEntry(input: PurchaseEntryInput): Promise<{ purchaseEntryId: number }> {
  if (input.source === "DIRECT_ADJUSTMENT" && !input.adjustmentReason) {
    throw new Error("A direct stock adjustment requires a reason");
  }

  return db.transaction(async (tx) => {
    const [entry] = await tx
      .insert(purchaseEntries)
      .values({
        companyId: input.companyId,
        warehouseId: input.warehouseId,
        supplierId: input.supplierId ?? null,
        source: input.source,
        poReference: input.poReference ?? null,
        supplierInvoiceNumber: input.supplierInvoiceNumber ?? null,
        invoiceDate: input.invoiceDate ?? null,
        adjustmentReason: input.adjustmentReason ?? null,
        createdByUserId: input.createdByUserId ?? null,
      })
      .returning({ id: purchaseEntries.id });

    for (const item of input.items) {
      await tx.insert(purchaseEntryItems).values({
        purchaseEntryId: entry.id,
        skuId: item.skuId,
        quantity: item.quantity,
        unitCost: item.unitCost,
      });

      await lockSkuWarehouse(tx, item.skuId, input.warehouseId);
      await receiveStock(tx, {
        skuId: item.skuId,
        warehouseId: input.warehouseId,
        quantity: item.quantity,
        reason: "PURCHASE_RECEIPT",
        referenceType: "purchase_entry",
        referenceId: String(entry.id),
      });
    }

    return { purchaseEntryId: entry.id };
  });
}
