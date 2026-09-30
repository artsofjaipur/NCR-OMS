import { and, eq, ilike } from "drizzle-orm";
import { db } from "../../db/client";
import { skus, partyPayments } from "../../db/schema";
import { recordPurchaseEntry } from "./purchases";
import { parseStockInCsv, type StockInRow } from "../../ingestion/parsers/stockIn";

export interface StockInImportInput {
  companyId: number;
  brandId: number;
  supplierId: number;
  warehouseId: number;
  createdByUserId: number | null;
  fileName: string;
  csvText: string;
  gstPercent?: string; // defaults to "5" — every real sheet seen used 5% GST
}

export interface StockInImportResult {
  entryCount: number;
  skuCreatedCount: number;
  paidCount: number;
  totalQuantity: number;
  totalPayable: string;
  skippedRowCount: number;
  warnings: string[];
  unmappedSkuSamples: string[]; // codes/products that had to be auto-created, for the user to review/rename
}

function slugForSku(productName: string): string {
  return productName
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60) || "STOCK-IN-ITEM";
}

/** True when a remark/status word means "this bill is paid" — deliberately excludes "unpaid"/"not paid". */
function looksPaid(text: string | null): boolean {
  if (!text) return false;
  const t = text.toLowerCase();
  if (/(un|not)\s*paid/.test(t)) return false;
  return /\bpaid\b/.test(t);
}

export async function importStockInCsv(input: StockInImportInput): Promise<StockInImportResult> {
  const parsed = parseStockInCsv(input.csvText);
  const gstPercent = input.gstPercent ?? "5";

  const skuCache = new Map<string, number>(); // normalized code -> sku id
  let skuCreatedCount = 0;
  let paidCount = 0;
  let totalQuantity = 0;
  let totalPayable = 0;
  const unmapped: string[] = [];

  async function resolveSkuId(row: StockInRow): Promise<number> {
    const rawCode = row.skuCodeRaw?.trim();
    const code = rawCode || slugForSku(row.productName || "Stock In Item");
    const cacheKey = code.toUpperCase();
    const cached = skuCache.get(cacheKey);
    if (cached) return cached;

    const [existing] = await db
      .select({ id: skus.id })
      .from(skus)
      .where(and(eq(skus.brandId, input.brandId), ilike(skus.code, code)))
      .limit(1);
    if (existing) {
      skuCache.set(cacheKey, existing.id);
      return existing.id;
    }

    const [created] = await db
      .insert(skus)
      .values({
        brandId: input.brandId,
        code,
        productTitle: row.productName || code,
        isActive: true,
      })
      .returning({ id: skus.id });
    skuCache.set(cacheKey, created.id);
    skuCreatedCount++;
    if (!rawCode) unmapped.push(`"${row.productName}" → auto-created SKU "${code}" (sheet had no SKU code)`);
    return created.id;
  }

  for (const row of parsed.rows) {
    const skuId = await resolveSkuId(row);
    const { purchaseEntryId } = await recordPurchaseEntry({
      companyId: input.companyId,
      warehouseId: input.warehouseId,
      supplierId: input.supplierId,
      source: "PURCHASE_ORDER",
      supplierInvoiceNumber: row.supplierInvoiceNumber,
      invoiceDate: row.invoiceDate,
      dueDate: null,
      notes: row.remark,
      entryDate: row.entryDate,
      partyChalanNo: row.partyChalanNo,
      ourChalanNo: row.ourChalanNo,
      gstPercent,
      createdByUserId: input.createdByUserId,
      items: [{ skuId, quantity: row.quantity, unitCost: row.rate.toFixed(2) }],
    });

    totalQuantity += row.quantity;
    const subtotal = row.quantity * row.rate;
    const payable = subtotal * (1 + Number(gstPercent) / 100);
    totalPayable += payable;

    let paidAmount: number | null = null;
    if (row.paidAmount != null && row.paidAmount > 0) paidAmount = row.paidAmount;
    else if (row.paidDate) paidAmount = payable;
    else if (looksPaid(row.paidFlagText)) paidAmount = payable;

    if (paidAmount != null && paidAmount > 0) {
      paidCount++;
      await db.insert(partyPayments).values({
        companyId: input.companyId,
        supplierId: input.supplierId,
        purchaseEntryId,
        amount: paidAmount.toFixed(2),
        method: "BANK_TRANSFER",
        reference: row.partyChalanNo || row.supplierInvoiceNumber || undefined,
        paidAt: row.paidDate || row.entryDate || new Date(),
        notes: row.remark || undefined,
        createdByUserId: input.createdByUserId ?? undefined,
      });
    }
  }

  return {
    entryCount: parsed.rows.length,
    skuCreatedCount,
    paidCount,
    totalQuantity,
    totalPayable: totalPayable.toFixed(2),
    skippedRowCount: parsed.skippedRowCount,
    warnings: parsed.warnings,
    unmappedSkuSamples: unmapped.slice(0, 20),
  };
}
