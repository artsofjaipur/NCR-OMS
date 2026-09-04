import { Router } from "express";
import { z } from "zod";
import { requireAuth, requireCompanyScope } from "../middleware/auth";
import { recordPurchaseEntry } from "../modules/purchases/purchases";

export const purchasesRouter = Router();
purchasesRouter.use(requireAuth, requireCompanyScope);

const schema = z.object({
  warehouseId: z.number().int().positive(),
  supplierId: z.number().int().positive().optional(),
  source: z.enum(["PURCHASE_ORDER", "DIRECT_ADJUSTMENT"]),
  poReference: z.string().optional(),
  supplierInvoiceNumber: z.string().optional(),
  invoiceDate: z.string().datetime().optional(),
  adjustmentReason: z.string().optional(),
  items: z.array(z.object({ skuId: z.number().int().positive(), quantity: z.number().int().positive(), unitCost: z.string() })).min(1),
});

/** Purchase Entry & Direct Stock Update: PO-backed receipt or a reasoned manual bump, both hit the ledger. */
purchasesRouter.post("/", async (req, res, next) => {
  try {
    const body = schema.parse(req.body);
    const result = await recordPurchaseEntry({
      companyId: req.session!.companyId,
      warehouseId: body.warehouseId,
      supplierId: body.supplierId ?? null,
      source: body.source,
      poReference: body.poReference ?? null,
      supplierInvoiceNumber: body.supplierInvoiceNumber ?? null,
      invoiceDate: body.invoiceDate ? new Date(body.invoiceDate) : null,
      adjustmentReason: body.adjustmentReason ?? null,
      createdByUserId: req.session!.userId,
      items: body.items,
    });
    res.status(201).json(result);
  } catch (err) {
    next(err);
  }
});
