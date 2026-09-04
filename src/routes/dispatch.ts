import { Router } from "express";
import { requireAuth, requireCompanyScope } from "../middleware/auth";
import { buildPicklist, buildCourierPackingSheets, markShipmentPacked } from "../modules/dispatch/dailyDispatch";

export const dispatchRouter = Router();
dispatchRouter.use(requireAuth, requireCompanyScope);

dispatchRouter.get("/picklist/:brandId", async (req, res, next) => {
  try {
    res.json(await buildPicklist(Number(req.params.brandId)));
  } catch (err) {
    next(err);
  }
});

dispatchRouter.get("/packing-sheets/:brandId", async (req, res, next) => {
  try {
    res.json(await buildCourierPackingSheets(Number(req.params.brandId)));
  } catch (err) {
    next(err);
  }
});

dispatchRouter.post("/shipments/:id/packed", async (req, res, next) => {
  try {
    await markShipmentPacked(Number(req.params.id));
    res.status(204).end();
  } catch (err) {
    next(err);
  }
});
