import { Router } from "express";
import { z } from "zod";
import { requireAuth, requireCompanyScope, requireRole } from "../middleware/auth";
import { pullExpectedPayout, confirmReceivedPayout } from "../modules/payouts/payouts";

export const payoutsRouter = Router();
payoutsRouter.use(requireAuth, requireCompanyScope);

const pullSchema = z.object({
  marketplaceAccountId: z.number().int().positive(),
  expectedDate: z.string().datetime(),
  orderTotals: z.array(z.object({ orderId: z.number().int().positive(), expectedAmount: z.string() })).min(1),
});

payoutsRouter.post("/pull-expected", async (req, res, next) => {
  try {
    const body = pullSchema.parse(req.body);
    const result = await pullExpectedPayout({ ...body, expectedDate: new Date(body.expectedDate) });
    res.status(201).json(result);
  } catch (err) {
    next(err);
  }
});

const confirmSchema = z.object({
  receivedAmount: z.string(),
  receivedDate: z.string().datetime(),
  bankReference: z.string().min(1),
});

// Confirmation moves real money on the books — OWNER/ADMIN only.
payoutsRouter.post("/:id/confirm-received", requireRole("OWNER", "ADMIN"), async (req, res, next) => {
  try {
    const body = confirmSchema.parse(req.body);
    await confirmReceivedPayout({
      payoutBatchId: Number(req.params.id),
      receivedAmount: body.receivedAmount,
      receivedDate: new Date(body.receivedDate),
      bankReference: body.bankReference,
    });
    res.status(204).end();
  } catch (err) {
    next(err);
  }
});
