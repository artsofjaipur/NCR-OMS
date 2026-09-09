import { Router } from "express";
import { z } from "zod";
import { and, eq } from "drizzle-orm";
import { db } from "../db/client";
import { partyPayments, purchaseEntries, suppliers } from "../db/schema";
import { requireSection } from "../security/permissions";
import { requireAuth, requireCompanyScope, requireRole } from "../middleware/auth";
import { HttpError } from "../middleware/errorHandler";

export const suppliersRouter = Router();
suppliersRouter.use(requireAuth, requireCompanyScope, requireSection("setup"));

/** Parties you buy stock from — referenced by purchase bills. */
suppliersRouter.get("/", async (req, res, next) => {
  try {
    const rows = await db
      .select({
        id: suppliers.id,
        name: suppliers.name,
        gstin: suppliers.gstin,
        contactPhone: suppliers.contactPhone,
        contactEmail: suppliers.contactEmail,
        city: suppliers.city,
      })
      .from(suppliers)
      .where(eq(suppliers.companyId, req.session!.companyId))
      .orderBy(suppliers.name);
    res.json(rows);
  } catch (err) {
    next(err);
  }
});

const supplierSchema = z.object({
  name: z.string().trim().min(2).max(150),
  gstin: z.string().trim().max(15).optional(),
  contactPhone: z.string().trim().max(20).optional(),
  contactEmail: z.string().trim().email().optional(),
  addressLine1: z.string().trim().max(250).optional(),
  city: z.string().trim().max(100).optional(),
  state: z.string().trim().max(100).optional(),
});

suppliersRouter.post("/", requireRole("OWNER", "ADMIN"), async (req, res, next) => {
  try {
    const body = supplierSchema.parse(req.body);
    const [row] = await db
      .insert(suppliers)
      .values({ companyId: req.session!.companyId, ...body })
      .returning({ id: suppliers.id, name: suppliers.name });
    res.status(201).json(row);
  } catch (err) {
    next(err);
  }
});

/** Edit a party — bills/payments referencing it keep their link. */
suppliersRouter.patch("/:id", requireRole("OWNER", "ADMIN"), async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) throw new HttpError(400, "Invalid party id");
    const body = supplierSchema.partial().parse(req.body);
    const [owned] = await db
      .select({ id: suppliers.id })
      .from(suppliers)
      .where(and(eq(suppliers.id, id), eq(suppliers.companyId, req.session!.companyId)))
      .limit(1);
    if (!owned) throw new HttpError(404, "Party not found in your workspace");
    await db.update(suppliers).set(body).where(eq(suppliers.id, id));
    res.status(204).end();
  } catch (err) {
    next(err);
  }
});

/** Delete a party — blocked while bills or payments reference it. */
suppliersRouter.delete("/:id", requireRole("OWNER", "ADMIN"), async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) throw new HttpError(400, "Invalid party id");
    const [owned] = await db
      .select({ id: suppliers.id })
      .from(suppliers)
      .where(and(eq(suppliers.id, id), eq(suppliers.companyId, req.session!.companyId)))
      .limit(1);
    if (!owned) throw new HttpError(404, "Party not found in your workspace");

    const [billHit] = await db.select({ id: purchaseEntries.id }).from(purchaseEntries).where(eq(purchaseEntries.supplierId, id)).limit(1);
    const [payHit] = await db.select({ id: partyPayments.id }).from(partyPayments).where(eq(partyPayments.supplierId, id)).limit(1);
    if (billHit || payHit) {
      throw new HttpError(409, "This party has bills or payments on record — it cannot be deleted or the ledger would break. Rename it instead.");
    }
    await db.delete(suppliers).where(eq(suppliers.id, id));
    res.status(204).end();
  } catch (err) {
    next(err);
  }
});
