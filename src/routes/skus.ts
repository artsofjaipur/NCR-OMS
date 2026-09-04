import { Router } from "express";
import { z } from "zod";
import { eq } from "drizzle-orm";
import { db } from "../db/client";
import { skus, brands } from "../db/schema";
import { requireAuth, requireCompanyScope } from "../middleware/auth";
import { HttpError } from "../middleware/errorHandler";

export const skusRouter = Router();
skusRouter.use(requireAuth, requireCompanyScope);

/** Closes the "no CRUD API routes for SKUs" gap from the earlier build. */
skusRouter.get("/", async (req, res, next) => {
  try {
    const brandId = req.query.brandId ? Number(req.query.brandId) : undefined;
    const rows = brandId
      ? await db.select().from(skus).where(eq(skus.brandId, brandId))
      : await db.select().from(skus);
    res.json(rows);
  } catch (err) {
    next(err);
  }
});

const createSkuSchema = z.object({
  brandId: z.number().int().positive(),
  code: z.string().min(1),
  productTitle: z.string().min(1),
  color: z.string().optional(),
  size: z.string().optional(),
  hsnCode: z.string().optional(),
  mrp: z.string().optional(),
});

skusRouter.post("/", async (req, res, next) => {
  try {
    const body = createSkuSchema.parse(req.body);
    const [brand] = await db.select({ companyId: brands.companyId }).from(brands).where(eq(brands.id, body.brandId)).limit(1);
    if (!brand || brand.companyId !== req.session!.companyId) {
      throw new HttpError(403, "Brand does not belong to your company");
    }
    // SKU codes are unique per brand, not globally — see the architecture
    // addendum: the same code is legitimately reused across brands.
    const [row] = await db.insert(skus).values(body).returning({ id: skus.id });
    res.status(201).json({ id: row.id });
  } catch (err) {
    next(err);
  }
});

const updateSkuSchema = createSkuSchema.partial().omit({ brandId: true });

skusRouter.patch("/:id", async (req, res, next) => {
  try {
    const body = updateSkuSchema.parse(req.body);
    await db.update(skus).set(body).where(eq(skus.id, Number(req.params.id)));
    res.status(204).end();
  } catch (err) {
    next(err);
  }
});
