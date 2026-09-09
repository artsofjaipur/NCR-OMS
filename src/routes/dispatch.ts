import { Router } from "express";
import { z } from "zod";
import { and, desc, eq, inArray, or } from "drizzle-orm";
import { db } from "../db/client";
import { orders, shipments, marketplaceAccounts, brands } from "../db/schema";
import { requireAuth, requireCompanyScope } from "../middleware/auth";
import { requireSection } from "../security/permissions";
import { HttpError } from "../middleware/errorHandler";
import { markShipmentPacked } from "../modules/dispatch/dailyDispatch";

export const dispatchRouter = Router();
dispatchRouter.use(requireAuth, requireCompanyScope, requireSection("dispatch"));

dispatchRouter.get("/picklist/:brandId", async (req, res, next) => {
  try {
    res.json(await buildPicklistSafe(Number(req.params.brandId)));
  } catch (err) {
    next(err);
  }
});

dispatchRouter.get("/packing-sheets/:brandId", async (req, res, next) => {
  try {
    res.json(await buildSheetsSafe(Number(req.params.brandId)));
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

// ---------------------------------------------------------------------------
// PACK SCAN — the floor's barcode workflow. Scan the AWB / order id printed on
// the label; the shipment is marked packed and the order flips to
// READY_TO_DISPATCH so everyone can see "packed, ready to go".
// Idempotent: scanning the same label twice never double-fires.
// ---------------------------------------------------------------------------

const packScanSchema = z.object({
  code: z.string().trim().min(3).max(120),
});

dispatchRouter.post("/scan", async (req, res, next) => {
  try {
    const body = packScanSchema.parse(req.body);
    const companyId = req.session!.companyId;
    const code = body.code;

    // The label may carry an AWB, a marketplace order id, or a shipment id.
    // Text columns are tried first (order ids and AWBs are both long digit
    // strings — matching them against int ids would overflow), and a small
    // numeric code falls back to shipment id.
    const numeric = Number(code);
    const baseSelect = db
      .select({
        shipmentId: shipments.id,
        packedAt: shipments.packedAt,
        awb: shipments.awbNumber,
        carrier: shipments.carrier,
        orderId: orders.id,
        orderStatus: orders.status,
        marketplaceOrderId: orders.marketplaceOrderId,
        marketplace: marketplaceAccounts.marketplace,
        sellerAccountLabel: marketplaceAccounts.sellerAccountLabel,
        brandName: brands.name,
      })
      .from(shipments)
      .innerJoin(orders, eq(orders.id, shipments.orderId))
      .innerJoin(marketplaceAccounts, eq(marketplaceAccounts.id, orders.marketplaceAccountId))
      .innerJoin(brands, eq(brands.id, marketplaceAccounts.brandId));

    let candidates = await baseSelect
      .where(
        and(
          eq(brands.companyId, companyId),
          or(eq(shipments.awbNumber, code), eq(orders.marketplaceOrderId, code))
        )
      )
      .limit(1);

    if (!candidates.length && Number.isInteger(numeric) && numeric > 0 && numeric < 1_000_000_000) {
      candidates = await baseSelect
        .where(and(eq(brands.companyId, companyId), eq(shipments.id, numeric)))
        .limit(1);
    }

    const found = candidates[0];
    if (!found) {
      throw new HttpError(404, `No shipment found for "${code}" in your workspace`);
    }

    if (!found.packedAt) {
      await markShipmentPacked(found.shipmentId);
      // Pack completion is what the marketplace flow means by "ready to dispatch".
      await db
        .update(orders)
        .set({ status: "READY_TO_DISPATCH" })
        .where(and(eq(orders.id, found.orderId), inArray(orders.status, ["CREATED"])));
    }

    res.json({
      shipmentId: found.shipmentId,
      order: found.marketplaceOrderId,
      brand: found.brandName,
      marketplace: found.marketplace,
      sellerAccount: found.sellerAccountLabel,
      courier: found.carrier ?? "UNASSIGNED",
      awb: found.awb,
      packed: true,
      alreadyPacked: Boolean(found.packedAt),
    });
  } catch (err) {
    next(err);
  }
});

// Lazy imports keep the module import graph identical to before.
async function buildPicklistSafe(brandId: number) {
  const mod = await import("../modules/dispatch/dailyDispatch");
  return mod.buildPicklist(brandId);
}
async function buildSheetsSafe(brandId: number) {
  const mod = await import("../modules/dispatch/dailyDispatch");
  return mod.buildCourierPackingSheets(brandId);
}
