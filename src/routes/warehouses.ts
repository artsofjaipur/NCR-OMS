import { Router } from "express";
import { z } from "zod";
import { and, eq, ne } from "drizzle-orm";
import { db } from "../db/client";
import { inventoryLedger, shipments, warehouses } from "../db/schema";
import { requireSection } from "../security/permissions";
import { requireAuth, requireCompanyScope, requireRole } from "../middleware/auth";
import { HttpError } from "../middleware/errorHandler";

export const warehousesRouter = Router();
warehousesRouter.use(requireAuth, requireCompanyScope, requireSection("setup"));

warehousesRouter.get("/", async (req, res, next) => {
  try {
    const rows = await db.select().from(warehouses).where(eq(warehouses.companyId, req.session!.companyId));
    res.json(rows);
  } catch (err) {
    next(err);
  }
});

const createSchema = z.object({
  name: z.string().min(1),
  city: z.string().optional(),
  isDefault: z.boolean().optional(),
});

warehousesRouter.post("/", requireRole("OWNER", "ADMIN"), async (req, res, next) => {
  try {
    const body = createSchema.parse(req.body);
    const [row] = await db
      .insert(warehouses)
      .values({ companyId: req.session!.companyId, ...body })
      .returning({ id: warehouses.id });
    res.status(201).json({ id: row.id });
  } catch (err) {
    next(err);
  }
});

/** Rename / move / set-default. Only one default per company at a time. */
warehousesRouter.patch("/:id", requireRole("OWNER", "ADMIN"), async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) throw new HttpError(400, "Invalid warehouse id");
    const body = createSchema.partial().parse(req.body);

    const [owned] = await db
      .select({ id: warehouses.id })
      .from(warehouses)
      .where(and(eq(warehouses.id, id), eq(warehouses.companyId, req.session!.companyId)))
      .limit(1);
    if (!owned) throw new HttpError(404, "Warehouse not found in your workspace");

    if (body.isDefault) {
      await db
        .update(warehouses)
        .set({ isDefault: false })
        .where(and(eq(warehouses.companyId, req.session!.companyId), ne(warehouses.id, id)));
    }
    const patch: Record<string, unknown> = {};
    if (body.name !== undefined) patch.name = body.name;
    if (body.city !== undefined) patch.city = body.city;
    if (body.isDefault !== undefined) patch.isDefault = body.isDefault;
    await db.update(warehouses).set(patch).where(eq(warehouses.id, id));
    res.status(204).end();
  } catch (err) {
    next(err);
  }
});

/** Delete only an empty warehouse — stock ledger rows and shipments are permanent history. */
warehousesRouter.delete("/:id", requireRole("OWNER", "ADMIN"), async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) throw new HttpError(400, "Invalid warehouse id");
    const [owned] = await db
      .select({ id: warehouses.id })
      .from(warehouses)
      .where(and(eq(warehouses.id, id), eq(warehouses.companyId, req.session!.companyId)))
      .limit(1);
    if (!owned) throw new HttpError(404, "Warehouse not found in your workspace");

    const [stockHit] = await db.select({ id: inventoryLedger.id }).from(inventoryLedger).where(eq(inventoryLedger.warehouseId, id)).limit(1);
    const [shipHit] = await db.select({ id: shipments.id }).from(shipments).where(eq(shipments.warehouseId, id)).limit(1);
    if (stockHit || shipHit) {
      throw new HttpError(409, "This warehouse has stock movements or shipments — it cannot be deleted. Rename it instead.");
    }
    await db.delete(warehouses).where(eq(warehouses.id, id));
    res.status(204).end();
  } catch (err) {
    next(err);
  }
});
