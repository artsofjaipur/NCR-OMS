import { Router } from "express";
import { z } from "zod";
import { and, eq } from "drizzle-orm";
import { db } from "../db/client";
import { purchaseEntries, brands, warehouses, suppliers } from "../db/schema";
import { requireAuth, requireCompanyScope, requireRole } from "../middleware/auth";
import { requireSection } from "../security/permissions";
import { HttpError } from "../middleware/errorHandler";
import { recordPurchaseEntry, updatePurchaseEntry, deletePurchaseEntry, listPurchaseEntries } from "../modules/purchases/purchases";
import { importStockInCsv } from "../modules/purchases/stockInImport";

export const purchasesRouter = Router();
purchasesRouter.use(requireAuth, requireCompanyScope, requireSection("inventory"));

/**
 * Stock-In ledger — party-wise purchase entries (challan no., GST, bill and
 * payment tracking), added 2026-09-25 per user request: "sabhi entry auto
 * calculate ho or edite delete option ke sath ho or entry page bhi ho dilog
 * box hi open ho" (every entry auto-calculates, has edit/delete, and the
 * entry form opens as a dialog). See modules/purchases/purchases.ts and
 * BRAIN.md for the full design writeup.
 */

async function assertOwnsWarehouse(companyId: number, warehouseId: number) {
  const [row] = await db.select({ id: warehouses.id }).from(warehouses).where(and(eq(warehouses.id, warehouseId), eq(warehouses.companyId, companyId))).limit(1);
  if (!row) throw new HttpError(404, "Warehouse not found in your workspace");
}
async function assertOwnsSupplier(companyId: number, supplierId: number) {
  const [row] = await db.select({ id: suppliers.id }).from(suppliers).where(and(eq(suppliers.id, supplierId), eq(suppliers.companyId, companyId))).limit(1);
  if (!row) throw new HttpError(404, "Party not found in your workspace");
}
async function assertOwnsBrand(companyId: number, brandId: number) {
  const [row] = await db.select({ id: brands.id }).from(brands).where(and(eq(brands.id, brandId), eq(brands.companyId, companyId))).limit(1);
  if (!row) throw new HttpError(404, "Brand not found in your workspace");
}
async function assertOwnsEntry(companyId: number, entryId: number) {
  const [row] = await db.select({ id: purchaseEntries.id }).from(purchaseEntries).where(and(eq(purchaseEntries.id, entryId), eq(purchaseEntries.companyId, companyId))).limit(1);
  if (!row) throw new HttpError(404, "Entry not found in your workspace");
}

const schema = z.object({
  warehouseId: z.number().int().positive(),
  supplierId: z.number().int().positive().optional(),
  source: z.enum(["PURCHASE_ORDER", "DIRECT_ADJUSTMENT"]),
  poReference: z.string().optional(),
  supplierInvoiceNumber: z.string().optional(),
  invoiceDate: z.string().datetime().optional(),
  adjustmentReason: z.string().optional(),
  dueDate: z.string().datetime().optional(),
  notes: z.string().optional(),
  entryDate: z.string().datetime().optional(),
  partyChalanNo: z.string().optional(),
  ourChalanNo: z.string().optional(),
  gstPercent: z.string().regex(/^\d+(\.\d{1,2})?$/).optional(),
  items: z.array(z.object({ skuId: z.number().int().positive(), quantity: z.number().int().positive(), unitCost: z.string() })).min(1),
});

/** Purchase Entry & Direct Stock Update: PO-backed receipt or a reasoned manual bump, both hit the ledger. */
purchasesRouter.post("/", async (req, res, next) => {
  try {
    const body = schema.parse(req.body);
    await assertOwnsWarehouse(req.session!.companyId, body.warehouseId);
    if (body.supplierId) await assertOwnsSupplier(req.session!.companyId, body.supplierId);
    const result = await recordPurchaseEntry({
      companyId: req.session!.companyId,
      warehouseId: body.warehouseId,
      supplierId: body.supplierId ?? null,
      source: body.source,
      poReference: body.poReference ?? null,
      supplierInvoiceNumber: body.supplierInvoiceNumber ?? null,
      invoiceDate: body.invoiceDate ? new Date(body.invoiceDate) : null,
      adjustmentReason: body.adjustmentReason ?? null,
      dueDate: body.dueDate ? new Date(body.dueDate) : null,
      notes: body.notes ?? null,
      entryDate: body.entryDate ? new Date(body.entryDate) : null,
      partyChalanNo: body.partyChalanNo ?? null,
      ourChalanNo: body.ourChalanNo ?? null,
      gstPercent: body.gstPercent ?? null,
      createdByUserId: req.session!.userId,
      items: body.items,
    });
    res.status(201).json(result);
  } catch (err) {
    next(err);
  }
});

/** Full Stock-In ledger, optionally filtered to one party — powers the entries table + running balance. */
purchasesRouter.get("/", async (req, res, next) => {
  try {
    const supplierId = req.query.supplierId ? Number(req.query.supplierId) : undefined;
    if (supplierId) await assertOwnsSupplier(req.session!.companyId, supplierId);
    const rows = await listPurchaseEntries(req.session!.companyId, supplierId);
    res.json(rows);
  } catch (err) {
    next(err);
  }
});

const patchSchema = z.object({
  supplierId: z.number().int().positive().nullable().optional(),
  supplierInvoiceNumber: z.string().nullable().optional(),
  invoiceDate: z.string().datetime().nullable().optional(),
  dueDate: z.string().datetime().nullable().optional(),
  notes: z.string().nullable().optional(),
  entryDate: z.string().datetime().nullable().optional(),
  partyChalanNo: z.string().nullable().optional(),
  ourChalanNo: z.string().nullable().optional(),
  gstPercent: z.string().regex(/^\d+(\.\d{1,2})?$/).nullable().optional(),
  item: z.object({ skuId: z.number().int().positive(), quantity: z.number().int().positive(), unitCost: z.string(), warehouseId: z.number().int().positive().optional() }).optional(),
});

/** Edit a Stock-In entry — header fields and/or the single item (SKU/qty/rate), with the ledger corrected to match. */
purchasesRouter.patch("/:id", requireRole("OWNER", "ADMIN"), async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) throw new HttpError(400, "Invalid entry id");
    await assertOwnsEntry(req.session!.companyId, id);
    const body = patchSchema.parse(req.body);
    if (body.supplierId) await assertOwnsSupplier(req.session!.companyId, body.supplierId);
    if (body.item?.warehouseId) await assertOwnsWarehouse(req.session!.companyId, body.item.warehouseId);

    await updatePurchaseEntry(id, {
      supplierId: body.supplierId,
      supplierInvoiceNumber: body.supplierInvoiceNumber,
      invoiceDate: body.invoiceDate !== undefined ? (body.invoiceDate ? new Date(body.invoiceDate) : null) : undefined,
      dueDate: body.dueDate !== undefined ? (body.dueDate ? new Date(body.dueDate) : null) : undefined,
      notes: body.notes,
      entryDate: body.entryDate !== undefined ? (body.entryDate ? new Date(body.entryDate) : null) : undefined,
      partyChalanNo: body.partyChalanNo,
      ourChalanNo: body.ourChalanNo,
      gstPercent: body.gstPercent,
      item: body.item,
    });
    res.status(204).end();
  } catch (err) {
    next(err);
  }
});

/** Delete a Stock-In entry — reverses its ledger effect first (see modules/purchases/purchases.ts). */
purchasesRouter.delete("/:id", requireRole("OWNER", "ADMIN"), async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) throw new HttpError(400, "Invalid entry id");
    await assertOwnsEntry(req.session!.companyId, id);
    await deletePurchaseEntry(id);
    res.status(204).end();
  } catch (err) {
    next(err);
  }
});

const importSchema = z.object({
  brandId: z.number().int().positive(),
  supplierId: z.number().int().positive(),
  warehouseId: z.number().int().positive(),
  fileName: z.string().min(1).max(300),
  csvText: z.string().min(1),
  gstPercent: z.string().regex(/^\d+(\.\d{1,2})?$/).optional(),
});

/**
 * Bulk-import a party's historical "MASTER STOCK SHEET" (Stock In) .csv —
 * every row becomes its own editable Stock-In entry (same as one dialog
 * save), so history and any new manual entry live in the same ledger/table.
 */
purchasesRouter.post("/import", requireRole("OWNER", "ADMIN"), async (req, res, next) => {
  try {
    const body = importSchema.parse(req.body);
    await assertOwnsBrand(req.session!.companyId, body.brandId);
    await assertOwnsSupplier(req.session!.companyId, body.supplierId);
    await assertOwnsWarehouse(req.session!.companyId, body.warehouseId);

    if (body.csvText.length > 8 * 1024 * 1024) throw new HttpError(400, "File is too large (8MB limit)");

    const result = await importStockInCsv({
      companyId: req.session!.companyId,
      brandId: body.brandId,
      supplierId: body.supplierId,
      warehouseId: body.warehouseId,
      createdByUserId: req.session!.userId,
      fileName: body.fileName,
      csvText: body.csvText,
      gstPercent: body.gstPercent,
    });
    res.status(201).json(result);
  } catch (err) {
    next(err);
  }
});
