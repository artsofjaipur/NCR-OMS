import { Router } from "express";
import { requireAuth, requireCompanyScope } from "../middleware/auth";
import { computeOrderMargin, computeBrandPnl, computeCompanyPnl } from "../modules/pnl/pnl";

export const pnlRouter = Router();
pnlRouter.use(requireAuth, requireCompanyScope);

pnlRouter.get("/orders/:id", async (req, res, next) => {
  try {
    res.json(await computeOrderMargin(Number(req.params.id)));
  } catch (err) {
    next(err);
  }
});

function parsePeriod(req: import("express").Request) {
  const start = req.query.periodStart ? new Date(String(req.query.periodStart)) : new Date(new Date().setDate(1));
  const end = req.query.periodEnd ? new Date(String(req.query.periodEnd)) : new Date();
  return { start, end };
}

pnlRouter.get("/brands/:id", async (req, res, next) => {
  try {
    const { start, end } = parsePeriod(req);
    res.json(await computeBrandPnl(Number(req.params.id), start, end));
  } catch (err) {
    next(err);
  }
});

pnlRouter.get("/companies/:id", async (req, res, next) => {
  try {
    if (Number(req.params.id) !== req.session!.companyId) {
      return res.status(403).json({ error: "Cannot read another company's P&L" });
    }
    const { start, end } = parsePeriod(req);
    res.json(await computeCompanyPnl(Number(req.params.id), start, end));
  } catch (err) {
    next(err);
  }
});
