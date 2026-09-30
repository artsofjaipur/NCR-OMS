import { and, desc, eq, sql } from "drizzle-orm";
import { db } from "../../db/client";
import { purchaseEntries, purchaseEntryItems, partyPayments, skus, suppliers } from "../../db/schema";
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
  dueDate?: Date | null;
  notes?: string | null;
  createdByUserId?: number | null;
  // Stock-In ledger fields — see schema.ts / drizzle/0005 comment.
  entryDate?: Date | null;
  partyChalanNo?: string | null;
  ourChalanNo?: string | null;
  gstPercent?: string | null;
  items: { skuId: number; quantity: number; unitCost: string }[];
}

function computeAmounts(items: { skuId: number; quantity: number; unitCost: string }[], gstPercent?: string | null) {
  const subtotal = items.reduce((sum, item) => sum + Number(item.unitCost || 0) * item.quantity, 0);
  const gstPct = gstPercent != null && gstPercent !== "" ? Number(gstPercent) : null;
  const gstAmount = gstPct != null ? subtotal * (gstPct / 100) : 0;
  const total = subtotal + gstAmount;
  return {
    subtotal: subtotal.toFixed(2),
    gstAmount: (gstPct != null ? gstAmount : 0).toFixed(2),
    total: total.toFixed(2),
  };
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
    const amounts = input.source === "PURCHASE_ORDER" ? computeAmounts(input.items, input.gstPercent) : null;

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
        // Bill finance (Zoho-style): derive the payable total from the line
        // items (+ GST when given), and carry the due date / notes for
        // aging + ledger views. Direct stock adjustments carry no supplier
        // bill — total stays NULL so they never pollute payable/outstanding.
        totalAmount: amounts ? amounts.total : null,
        subtotalAmount: amounts ? amounts.subtotal : null,
        gstAmount: amounts ? amounts.gstAmount : null,
        gstPercent: input.source === "PURCHASE_ORDER" ? input.gstPercent ?? null : null,
        dueDate: input.dueDate ?? null,
        notes: input.notes ?? null,
        entryDate: input.entryDate ?? null,
        partyChalanNo: input.partyChalanNo ?? null,
        ourChalanNo: input.ourChalanNo ?? null,
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

export interface PurchaseEntryUpdateInput {
  supplierId?: number | null;
  supplierInvoiceNumber?: string | null;
  invoiceDate?: Date | null;
  dueDate?: Date | null;
  notes?: string | null;
  entryDate?: Date | null;
  partyChalanNo?: string | null;
  ourChalanNo?: string | null;
  gstPercent?: string | null;
  // Item change — only supported when the entry has exactly one item (true
  // for every entry created via the dialog/CSV import; older multi-item
  // bills reject an item edit here with a clear error instead of silently
  // touching the wrong line).
  item?: { skuId: number; quantity: number; unitCost: string; warehouseId?: number };
}

/**
 * Edits a Stock-In entry. Header fields (chalan no., bill no./date, GST%,
 * notes, dates) are a plain UPDATE. A quantity/rate/SKU/warehouse change on
 * the item is NOT a plain UPDATE — it must correct the inventory ledger too,
 * since current stock is SUM(delta), not a mutable counter. We do this as a
 * reversal (MANUAL_ADJUSTMENT of -oldQty at the old sku/warehouse) followed
 * by a fresh PURCHASE_RECEIPT of the new qty at the new sku/warehouse, both
 * referencing this purchase entry — so the ledger's audit trail always shows
 * exactly what changed and when, rather than a number quietly changing
 * underneath a stock count someone may have already relied on.
 */
export async function updatePurchaseEntry(
  entryId: number,
  patch: PurchaseEntryUpdateInput,
): Promise<void> {
  await db.transaction(async (tx) => {
    const [existing] = await tx
      .select()
      .from(purchaseEntries)
      .where(eq(purchaseEntries.id, entryId))
      .limit(1);
    if (!existing) throw new Error("Purchase entry not found");

    let newSubtotal = existing.subtotalAmount;
    let newGstAmount = existing.gstAmount;
    let newTotal = existing.totalAmount;
    let targetWarehouseId = existing.warehouseId;

    if (patch.item) {
      const existingItems = await tx
        .select()
        .from(purchaseEntryItems)
        .where(eq(purchaseEntryItems.purchaseEntryId, entryId));
      if (existingItems.length !== 1) {
        throw new Error("This entry has more than one line item — quantity/rate edits aren't supported here yet");
      }
      const oldItem = existingItems[0];
      const newWarehouseId = patch.item.warehouseId ?? existing.warehouseId;

      // Reverse the old ledger effect.
      await lockSkuWarehouse(tx, oldItem.skuId, existing.warehouseId);
      await receiveStock(tx, {
        skuId: oldItem.skuId,
        warehouseId: existing.warehouseId,
        quantity: -oldItem.quantity,
        reason: "MANUAL_ADJUSTMENT",
        referenceType: "purchase_entry_edit",
        referenceId: String(entryId),
      });
      // Apply the new one.
      await lockSkuWarehouse(tx, patch.item.skuId, newWarehouseId);
      await receiveStock(tx, {
        skuId: patch.item.skuId,
        warehouseId: newWarehouseId,
        quantity: patch.item.quantity,
        reason: "PURCHASE_RECEIPT",
        referenceType: "purchase_entry_edit",
        referenceId: String(entryId),
      });

      await tx
        .update(purchaseEntryItems)
        .set({ skuId: patch.item.skuId, quantity: patch.item.quantity, unitCost: patch.item.unitCost })
        .where(eq(purchaseEntryItems.id, oldItem.id));

      targetWarehouseId = newWarehouseId;

      if (existing.source === "PURCHASE_ORDER") {
        const gstPercent = patch.gstPercent !== undefined ? patch.gstPercent : existing.gstPercent;
        const amounts = computeAmounts([{ skuId: patch.item.skuId, quantity: patch.item.quantity, unitCost: patch.item.unitCost }], gstPercent);
        newSubtotal = amounts.subtotal;
        newGstAmount = amounts.gstAmount;
        newTotal = amounts.total;
      }
    } else if (patch.gstPercent !== undefined && existing.source === "PURCHASE_ORDER") {
      // GST% changed but not the item — recompute off the existing subtotal.
      const subtotal = Number(existing.subtotalAmount || 0);
      const gstPct = patch.gstPercent != null && patch.gstPercent !== "" ? Number(patch.gstPercent) : null;
      const gstAmount = gstPct != null ? subtotal * (gstPct / 100) : 0;
      newGstAmount = (gstPct != null ? gstAmount : 0).toFixed(2);
      newTotal = (subtotal + (gstPct != null ? gstAmount : 0)).toFixed(2);
    }

    const setClause: Record<string, unknown> = {
      warehouseId: targetWarehouseId,
      subtotalAmount: newSubtotal,
      gstAmount: newGstAmount,
      totalAmount: newTotal,
    };
    if (patch.supplierId !== undefined) setClause.supplierId = patch.supplierId;
    if (patch.supplierInvoiceNumber !== undefined) setClause.supplierInvoiceNumber = patch.supplierInvoiceNumber;
    if (patch.invoiceDate !== undefined) setClause.invoiceDate = patch.invoiceDate;
    if (patch.dueDate !== undefined) setClause.dueDate = patch.dueDate;
    if (patch.notes !== undefined) setClause.notes = patch.notes;
    if (patch.entryDate !== undefined) setClause.entryDate = patch.entryDate;
    if (patch.partyChalanNo !== undefined) setClause.partyChalanNo = patch.partyChalanNo;
    if (patch.ourChalanNo !== undefined) setClause.ourChalanNo = patch.ourChalanNo;
    if (patch.gstPercent !== undefined) setClause.gstPercent = patch.gstPercent;

    await tx.update(purchaseEntries).set(setClause).where(eq(purchaseEntries.id, entryId));
  });
}

/**
 * Deletes a Stock-In entry entirely — reverses every item's ledger effect
 * (a MANUAL_ADJUSTMENT of -quantity, so the audit trail shows the stock
 * leaving as clearly as it showed the stock arriving), unlinks any payments
 * recorded against this bill (partyPayments.purchaseEntryId is
 * onDelete:"set null" — the payment itself stays on record, only the link
 * to this now-gone bill is cleared), then deletes the entry row (cascades
 * to purchaseEntryItems).
 */
export async function deletePurchaseEntry(entryId: number): Promise<void> {
  await db.transaction(async (tx) => {
    const [existing] = await tx.select().from(purchaseEntries).where(eq(purchaseEntries.id, entryId)).limit(1);
    if (!existing) throw new Error("Purchase entry not found");

    const items = await tx.select().from(purchaseEntryItems).where(eq(purchaseEntryItems.purchaseEntryId, entryId));
    for (const item of items) {
      await lockSkuWarehouse(tx, item.skuId, existing.warehouseId);
      await receiveStock(tx, {
        skuId: item.skuId,
        warehouseId: existing.warehouseId,
        quantity: -item.quantity,
        reason: "MANUAL_ADJUSTMENT",
        referenceType: "purchase_entry_delete",
        referenceId: String(entryId),
      });
    }

    await tx.delete(purchaseEntries).where(eq(purchaseEntries.id, entryId));
  });
}

/**
 * Full Stock-In ledger for a company (optionally one party) — one row per
 * entry with its single item's SKU/product/size flattened in, plus a
 * running "Total To be paid Balance" per party computed live with a window
 * function (never stored) so it's always correct no matter how many entries
 * were edited or deleted after the fact, and paid/balance-due figures
 * derived from partyPayments rather than a static "Paid?" flag.
 */
export async function listPurchaseEntries(companyId: number, supplierId?: number) {
  const whereClause = supplierId
    ? and(eq(purchaseEntries.companyId, companyId), eq(purchaseEntries.supplierId, supplierId))
    : eq(purchaseEntries.companyId, companyId);

  const rows = await db
    .select({
      id: purchaseEntries.id,
      supplierId: purchaseEntries.supplierId,
      supplierName: suppliers.name,
      warehouseId: purchaseEntries.warehouseId,
      source: purchaseEntries.source,
      entryDate: purchaseEntries.entryDate,
      createdAt: purchaseEntries.createdAt,
      partyChalanNo: purchaseEntries.partyChalanNo,
      ourChalanNo: purchaseEntries.ourChalanNo,
      supplierInvoiceNumber: purchaseEntries.supplierInvoiceNumber,
      invoiceDate: purchaseEntries.invoiceDate,
      gstPercent: purchaseEntries.gstPercent,
      subtotalAmount: purchaseEntries.subtotalAmount,
      gstAmount: purchaseEntries.gstAmount,
      totalAmount: purchaseEntries.totalAmount,
      dueDate: purchaseEntries.dueDate,
      notes: purchaseEntries.notes,
      adjustmentReason: purchaseEntries.adjustmentReason,
      itemId: purchaseEntryItems.id,
      skuId: purchaseEntryItems.skuId,
      skuCode: skus.code,
      productTitle: skus.productTitle,
      size: skus.size,
      quantity: purchaseEntryItems.quantity,
      unitCost: purchaseEntryItems.unitCost,
      paidAmount: sql<string>`coalesce((select sum(${partyPayments.amount}) from ${partyPayments} where ${partyPayments.purchaseEntryId} = ${purchaseEntries.id}), 0)::text`,
      lastPaidAt: sql<string | null>`(select max(${partyPayments.paidAt}) from ${partyPayments} where ${partyPayments.purchaseEntryId} = ${purchaseEntries.id})`,
      runningBalance: sql<string>`sum(coalesce(${purchaseEntries.totalAmount}, 0)) over (partition by ${purchaseEntries.supplierId} order by coalesce(${purchaseEntries.entryDate}, ${purchaseEntries.createdAt}), ${purchaseEntries.id})::text`,
    })
    .from(purchaseEntries)
    .leftJoin(suppliers, eq(suppliers.id, purchaseEntries.supplierId))
    .leftJoin(purchaseEntryItems, eq(purchaseEntryItems.purchaseEntryId, purchaseEntries.id))
    .leftJoin(skus, eq(skus.id, purchaseEntryItems.skuId))
    .where(whereClause)
    .orderBy(desc(sql`coalesce(${purchaseEntries.entryDate}, ${purchaseEntries.createdAt})`), desc(purchaseEntries.id))
    .limit(2000);

  return rows;
}
