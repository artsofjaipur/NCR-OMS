import { Router } from "express";
import { z } from "zod";
import { eq } from "drizzle-orm";
import { db } from "../db/client";
import { warehouses } from "../db/schema";
import { requireAuth, requireCompanyScope } from "../middleware/auth";

export const warehousesRouter = Router();
warehousesRouter.use(requireAuth, requireCompanyScope);

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

warehousesRouter.post("/", async (req, res, next) => {
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
