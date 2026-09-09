import { Router } from "express";
import { z } from "zod";
import { eq } from "drizzle-orm";
import { db } from "../db/client";
import { suppliers } from "../db/schema";
import { requireAuth, requireCompanyScope, requireRole } from "../middleware/auth";

export const suppliersRouter = Router();
suppliersRouter.use(requireAuth, requireCompanyScope);

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
