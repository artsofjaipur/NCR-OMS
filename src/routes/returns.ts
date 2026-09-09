import { Router } from "express";
import { z } from "zod";
import { and, desc, eq, inArray, sql } from "drizzle-orm";
import { db } from "../db/client";
import { returns, orders, orderItems, marketplaceAccounts, brands, skus } from "../db/schema";
import { requireAuth, requireCompanyScope, requireRole } from "../middleware/auth";
import { requireSection } from "../security/permissions";
import { HttpError } from "../middleware/errorHandler";
import { initiateReturn, markReturnReceived, recordQcResult, restockReturn } from "../modules/returns/returns";
import { parseCsvToRecords } from "../ingestion/csv";

export const returnsRouter = Router();
returnsRouter.use(requireAuth, requireCompanyScope, requireSection("returns"));

const initiateSchema = z.object({
  orderId: z.number().int().positive(),
  orderItemId: z.number().int().positive().optional(),
  reverseAwb: z.string().optional(),
  reverseCarrier: z.string().optional(),
  initiatedAt: z.string().datetime(),
});

returnsRouter.post("/", requireRole("OWNER", "ADMIN", "OPS"), async (req, res, next) => {
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

returnsRouter.post("/:id/qc", requireRole("OWNER", "ADMIN", "OPS"), async (req, res, next) => {
  try {
    const body = qcSchema.parse(req.body);
    await recordQcResult(Number(req.params.id), body.passed, body.notes);
    res.status(204).end();
  } catch (err) {
    next(err);
  }
});

const restockSchema = z.object({ warehouseId: z.number().int().positive() });

returnsRouter.post("/:id/restock", requireRole("OWNER", "ADMIN", "OPS"), async (req, res, next) => {
  try {
    const body = restockSchema.parse(req.body);
    await restockReturn(Number(req.params.id), body.warehouseId);
    res.status(204).end();
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------------------
// RETURN SHEET UPLOAD — the store's daily "aaj itne return hue" CSV. Rows are
// matched to orders by order id (or reverse AWB as fallback). Import is
// idempotent: a return already existing for the order is updated, never
// duplicated, so re-uploading the same sheet is always safe.
// ---------------------------------------------------------------------------

const importSchema = z.object({
  csv: z.string().min(5).max(5_000_000),
});

// Header spellings seen across marketplace return reports.
const ORDER_KEYS = ["order id", "order no", "order number", "orderid", "sub order no", "suborder no", "order_item_id", "order item id"];
const AWB_KEYS = ["awb", "awb number", "reverse awb", "reverse awb number", "tracking id", "awbno"];
const DATE_KEYS = ["return date", "date", "initiated date", "return initiated date", "rma date", "created at"];
const CARRIER_KEYS = ["courier", "carrier", "reverse courier", "courier name", "logistics partner"];
const STATUS_KEYS = ["return status", "status", "reason"];

function pick(rec: Record<string, string>, keys: string[]): string {
  for (const k of keys) {
    const hit = Object.keys(rec).find((rk) => rk.trim().toLowerCase() === k);
    if (hit && rec[hit]?.trim()) return rec[hit].trim();
  }
  return "";
}

returnsRouter.post("/import", requireRole("OWNER", "ADMIN", "OPS"), async (req, res, next) => {
  try {
    const body = importSchema.parse(req.body);
    const companyId = req.session!.companyId;

    const records = parseCsvToRecords(body.csv);
    if (!records.length) throw new HttpError(400, "CSV had no data rows");

    // Every order id in this workspace, for company-scope validation.
    const workspace = await db
      .select({ orderId: orders.id, orderNo: orders.marketplaceOrderId, brand: brands.name, mp: marketplaceAccounts.marketplace })
      .from(orders)
      .innerJoin(marketplaceAccounts, eq(marketplaceAccounts.id, orders.marketplaceAccountId))
      .innerJoin(brands, eq(brands.id, marketplaceAccounts.brandId))
      .where(eq(brands.companyId, companyId));
    const byOrderNo = new Map(workspace.map((w) => [w.orderNo, w]));

    const results: Array<Record<string, unknown>> = [];
    let imported = 0;
    let failed = 0;

    for (const [i, rec] of records.entries()) {
      const rowNo = i + 2; // header line offset
      const orderNo = pick(rec, ORDER_KEYS).replace(/^'/, "");
      const awb = pick(rec, AWB_KEYS) || null;
      const carrier = pick(rec, CARRIER_KEYS) || null;
      const rawStatus = pick(rec, STATUS_KEYS);
      const dateStr = pick(rec, DATE_KEYS);
      const initiatedAt = dateStr ? new Date(dateStr) : new Date();

      try {
        if (!orderNo && !awb) throw new Error("Row has neither Order ID nor AWB");
        const match = orderNo ? byOrderNo.get(orderNo) : undefined;
        if (!match) throw new Error(`Order "${orderNo || awb}" not found in this workspace — upload the order CSV first`);

        // Idempotent upsert: one open return per order.
        const [existing] = await db
          .select({ id: returns.id })
          .from(returns)
          .where(and(eq(returns.orderId, match.orderId), inArray(returns.status, ["INITIATED", "IN_TRANSIT", "RECEIVED", "QC_PASSED", "QC_FAILED"])))
          .limit(1);

        if (existing) {
          await db
            .update(returns)
            .set({
              reverseAwb: awb ?? undefined,
              reverseCarrier: carrier ?? undefined,
              initiatedAt: Number.isNaN(initiatedAt.getTime()) ? undefined : initiatedAt,
            })
            .where(eq(returns.id, existing.id));
          results.push({ row: rowNo, order: orderNo, returnId: existing.id, updated: true });
        } else {
          const { returnId } = await initiateReturn({
            orderId: match.orderId,
            reverseAwb: awb ?? undefined,
            reverseCarrier: carrier ?? undefined,
            initiatedAt: Number.isNaN(initiatedAt.getTime()) ? new Date() : initiatedAt,
          });
          results.push({ row: rowNo, order: orderNo, returnId, created: true, brand: match.brand, marketplace: match.mp });
        }
        imported += 1;
      } catch (e) {
        failed += 1;
        results.push({ row: rowNo, error: e instanceof Error ? e.message : String(e) });
      }
    }

    res.status(207).json({ imported, failed, results });
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------------------
// RETURN RECEIVE SCAN — scan the reverse-AWB / order label when the box
// physically arrives. Marks the return RECEIVED so the floor sees it in.
// ---------------------------------------------------------------------------

const scanSchema = z.object({ code: z.string().trim().min(3).max(120) });

returnsRouter.post("/scan", requireRole("OWNER", "ADMIN", "OPS"), async (req, res, next) => {
  try {
    const body = scanSchema.parse(req.body);
    const companyId = req.session!.companyId;
    const code = body.code;

    const rows = await db
      .select({
        returnId: returns.id,
        status: returns.status,
        reverseAwb: returns.reverseAwb,
        deliveredAt: returns.deliveredAt,
        orderNo: orders.marketplaceOrderId,
        brand: brands.name,
        marketplace: marketplaceAccounts.marketplace,
        skuCode: skus.code,
      })
      .from(returns)
      .innerJoin(orders, eq(orders.id, returns.orderId))
      .innerJoin(marketplaceAccounts, eq(marketplaceAccounts.id, orders.marketplaceAccountId))
      .innerJoin(brands, eq(brands.id, marketplaceAccounts.brandId))
      .leftJoin(orderItems, eq(orderItems.orderId, orders.id))
      .leftJoin(skus, eq(skus.id, orderItems.skuId))
      .where(
        and(
          eq(brands.companyId, companyId),
          inArray(returns.status, ["INITIATED", "IN_TRANSIT"]),
          code.includes("-") ? eq(orders.marketplaceOrderId, code) : eq(returns.reverseAwb, code)
        )
      )
      .limit(1);

    const found = rows[0];
    if (!found) {
      throw new HttpError(404, `No open return matches "${code}" — upload the return sheet first if this is a new return`);
    }

    await markReturnReceived(found.returnId, new Date());

    res.json({
      returnId: found.returnId,
      order: found.orderNo,
      brand: found.brand,
      marketplace: found.marketplace,
      sku: found.skuCode,
      status: "RECEIVED",
      next: "Run QC, then restock to add the unit back to inventory",
    });
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------------------
// RETURNS LIST + DAILY SUMMARY — "kis date ko kitne return initiate hue".
// ---------------------------------------------------------------------------

returnsRouter.get("/", async (req, res, next) => {
  try {
    const companyId = req.session!.companyId;
    const rows = await db
      .select({
        id: returns.id,
        status: returns.status,
        reverseAwb: returns.reverseAwb,
        reverseCarrier: returns.reverseCarrier,
        initiatedAt: returns.initiatedAt,
        deliveredAt: returns.deliveredAt,
        orderNo: orders.marketplaceOrderId,
        brand: brands.name,
        marketplace: marketplaceAccounts.marketplace,
      })
      .from(returns)
      .innerJoin(orders, eq(orders.id, returns.orderId))
      .innerJoin(marketplaceAccounts, eq(marketplaceAccounts.id, orders.marketplaceAccountId))
      .innerJoin(brands, eq(brands.id, marketplaceAccounts.brandId))
      .where(eq(brands.companyId, companyId))
      .orderBy(desc(returns.initiatedAt))
      .limit(200);
    res.json(rows);
  } catch (err) {
    next(err);
  }
});

returnsRouter.get("/daily", async (req, res, next) => {
  try {
    const companyId = req.session!.companyId;
    const rows = await db
      .select({
        day: sql<string>`to_char(date_trunc('day', ${returns.initiatedAt}), 'YYYY-MM-DD')`,
        brand: brands.name,
        marketplace: marketplaceAccounts.marketplace,
        count: sql<number>`count(*)::int`,
      })
      .from(returns)
      .innerJoin(orders, eq(orders.id, returns.orderId))
      .innerJoin(marketplaceAccounts, eq(marketplaceAccounts.id, orders.marketplaceAccountId))
      .innerJoin(brands, eq(brands.id, marketplaceAccounts.brandId))
      .where(eq(brands.companyId, companyId))
      .groupBy(sql`date_trunc('day', ${returns.initiatedAt})`, brands.name, marketplaceAccounts.marketplace)
      .orderBy(sql`date_trunc('day', ${returns.initiatedAt}) desc`);
    res.json(rows);
  } catch (err) {
    next(err);
  }
});
