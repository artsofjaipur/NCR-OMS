import { Router } from "express";
import { z } from "zod";
import { requireAuth, requireCompanyScope } from "../middleware/auth";
import { initiateReturn, markReturnReceived, recordQcResult, restockReturn } from "../modules/returns/returns";

export const returnsRouter = Router();
returnsRouter.use(requireAuth, requireCompanyScope);

const initiateSchema = z.object({
  orderId: z.number().int().positive(),
  orderItemId: z.number().int().positive().optional(),
  reverseAwb: z.string().optional(),
  reverseCarrier: z.string().optional(),
  initiatedAt: z.string().datetime(),
});

returnsRouter.post("/", async (req, res, next) => {
  try {
    const body = initiateSchema.parse(req.body);
    const result = await initiateReturn({ ...body, initiatedAt: new Date(body.initiatedAt) });
    res.status(201).json(result);
  } catch (err) {
    next(err);
  }
});

/** Return Received — the warehouse-floor confirmation, separate from the marketplace's own status. */
returnsRouter.post("/:id/received", async (req, res, next) => {
  try {
    await markReturnReceived(Number(req.params.id), new Date());
    res.status(204).end();
  } catch (err) {
    next(err);
  }
});

const qcSchema = z.object({ passed: z.boolean(), notes: z.string().optional() });

returnsRouter.post("/:id/qc", async (req, res, next) => {
  try {
    const body = qcSchema.parse(req.body);
    await recordQcResult(Number(req.params.id), body.passed, body.notes);
    res.status(204).end();
  } catch (err) {
    next(err);
  }
});

const restockSchema = z.object({ warehouseId: z.number().int().positive() });

returnsRouter.post("/:id/restock", async (req, res, next) => {
  try {
    const body = restockSchema.parse(req.body);
    await restockReturn(Number(req.params.id), body.warehouseId);
    res.status(204).end();
  } catch (err) {
    next(err);
  }
});
