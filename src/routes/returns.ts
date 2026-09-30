/**
 * Return sheet import + return lifecycle endpoints.
 * Return-type/reason capture + expanded Flipkart/Meesho header matching
 * added by Claude (Anthropic) — see BRAIN.md 2026-09-11 entry and Known
 * Open Issue #2 (RTO/return field mapping was Snapdeal-only before this).
 */
import { Router } from "express";
import { z } from "zod";
import { and, desc, eq, inArray, sql } from "drizzle-orm";
import { db } from "../db/client";
import { returns, orders, orderItems, marketplaceAccounts, brands, skus, companies, shipments } from "../db/schema";
import { requireAuth, requireCompanyScope, requireRole } from "../middleware/auth";
import { requireSection, scannableCompanyIds } from "../security/permissions";
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
  // Added alongside returnType/reason so a manually-entered return (Single
  // Entry page, or any future direct API call) can flag RTO the same way
  // the CSV import path's classifyReturnType() does -- without these,
  // initiateReturn()'s RTO -> orders.status=RTO_INITIATED auto-sync never
  // had a returnType to react to on this endpoint.
  returnType: z.string().max(40).optional(),
  reason: z.string().optional(),
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

// Header spellings seen across marketplace return reports. Verified live
// against a real Snapdeal return sheet; Flipkart and Meesho variants below
// are best-effort from their published seller-panel report layouts and have
// NOT yet been run against a real Flipkart/Meesho return-report CSV — if a
// real one turns up a header this list misses, add it here rather than
// touching the matching logic, so the fix stays a one-line addition.
const ORDER_KEYS = [
  "order id",
  "order no",
  "order number",
  "orderid",
  "sub order no",
  "suborder no",
  "sub order id",
  "suborder id",
  "order_item_id",
  "order item id",
  "orderitemid",
];
const AWB_KEYS = [
  "awb",
  "awb number",
  "awb no",
  "awbno",
  "reverse awb",
  "reverse awb number",
  "reverse awb no",
  "reverse shipment tracking id",
  "reverse tracking id",
  "return awb",
  "return awb number",
  "tracking id",
  "tracking number",
];
const DATE_KEYS = [
  "return date",
  "date",
  "initiated date",
  "return initiated date",
  "return init date",
  "rma date",
  "created at",
  "return creation date",
  "return request date",
  // "Return Initiated On" -- seen on a real Snapdeal-style return export
  // (2026-09-25) alongside "Return Delivered On" (RECEIVED_DATE_KEYS below).
  "return initiated on",
];
// When the portal itself already reports a delivered/received date (common
// for older, already-completed returns in a bulk export), the import marks
// the return RECEIVED with that date immediately -- rather than requiring
// every historical return to be walked through the Return Receive scan
// again just to backfill something the source data already knows.
const RECEIVED_DATE_KEYS = [
  "return delivered on",
  "return received date",
  "return received on",
  "delivered date",
  "received date",
  "delivery date",
];
const CARRIER_KEYS = [
  "courier",
  "carrier",
  "reverse courier",
  "reverse carrier",
  "courier name",
  "courier partner",
  "logistics partner",
  "shipping partner",
  // Flipkart's actual return-export column (confirmed live 2026-09-25 against
  // real Arvagam/Vardhamati/Kanjush return sheets) — without this, Flipkart
  // returns never got a carrier captured at all.
  "vendor name",
];
// The freeform explanation text a marketplace attaches to a return (e.g.
// "Size issue", "Order cancelled by buyer", "Undelivered — unreachable").
// Distinct from returnType (below), which is the RTO-vs-customer-return
// classification. "return reason" is checked before the generic "status" /
// "return status" -- a real Meesho return-export (confirmed 2026-09-25) has
// BOTH a "Status" column (shipment status, e.g. "Returned"/"Picked Up") AND
// its own "Return Reason" column; picking "status" first, as this list used
// to, silently captured the wrong text as the reason for every Meesho row.
const REASON_KEYS = [
  "return reason",
  "reason",
  "return sub reason",
  "rto reason",
  "cancellation reason",
  "return status",
  "status",
];
// An explicit classification column, when the marketplace provides one —
// Flipkart labels this "Return Type" ("Customer Return" / "RTO" / "Buyer
// Return"); Meesho's own column is literally named "Type of Return"
// (confirmed live 2026-09-25) -- without this key, Meesho's explicit type
// was missed entirely and fell through to reason-text guessing.
const TYPE_KEYS = ["return type", "returntype", "type of return", "type", "return category"];

function pick(rec: Record<string, string>, keys: string[]): string {
  for (const k of keys) {
    const hit = Object.keys(rec).find((rk) => rk.trim().toLowerCase() === k);
    if (hit && rec[hit]?.trim()) return rec[hit].trim();
  }
  return "";
}

/**
 * Best-effort RTO vs customer-return classification. Prefers an explicit
 * "Return Type" column; falls back to keyword-matching the reason text when
 * the sheet doesn't carry one. Returns null (never guesses) when neither
 * source gives a usable signal — an unclassified return is still imported,
 * just without this label.
 */
function classifyReturnType(explicitType: string, reasonText: string): string | null {
  const norm = (s: string) => s.trim().toLowerCase();
  const t = norm(explicitType);
  if (t) {
    // Flipkart's raw "courier_return" value IS an RTO in its own
    // terminology (the parcel never reached the customer) -- confirmed live
    // 2026-09-25 against real Flipkart return-export rows; without this the
    // classifier returned the unclassified literal string "courier_return"
    // instead of normalizing it, and the RTO->orders.status sync never fired.
    if (/\brto\b|return.?to.?origin|courier.?return/.test(t)) return "RTO";
    if (/customer|buyer/.test(t)) return "CUSTOMER_RETURN";
    return explicitType.trim().slice(0, 40); // pass through whatever the sheet said, capped to column width
  }
  const r = norm(reasonText);
  if (!r) return null;
  if (/\brto\b|undeliver|unreachable|refused|cancel(l)?ed by buyer|address issue|courier.?return/.test(r)) return "RTO";
  if (/return|exchange|size issue|quality issue|damaged|defective|wrong (item|product)/.test(r)) return "CUSTOMER_RETURN";
  return null;
}

/**
 * Best-effort marketplace detection from a return sheet's own column
 * headers -- one CSV upload is always one marketplace's report, so this
 * only needs to run once per import, not per row. Used only to resolve
 * which seller account a PLACEHOLDER order (see below) should be created
 * under; never guesses when the header shape isn't recognized.
 */
function detectMarketplace(headerKeys: string[]): "FLIPKART" | "MEESHO" | "SNAPDEAL" | null {
  const keys = new Set(headerKeys.map((k) => k.trim().toLowerCase()));
  if (keys.has("vendor name") && keys.has("location id")) return "FLIPKART";
  if (keys.has("suborder number") && keys.has("meesho pid")) return "MEESHO";
  if (keys.has("ordercode")) return "SNAPDEAL";
  return null;
}

/**
 * The store's own return-sheet workflow (user request, 2026-09-26,
 * Hinglish): "return chahe Meesho ka ho ya Flipkart, order sheet se match
 * kar ke mark kar de return initiated, jo nahi mile vo bhi record me save
 * ho jaye, jab aaye to sabko RECEIVED mark karna hai" -- a return that
 * can't be matched to an existing order must NOT be silently dropped
 * (the old behavior: throw and skip, nothing saved), because the physical
 * item is still coming and the warehouse-floor Return Receive scan
 * (POST /returns/scan) needs a real `returns` row to find later. Since
 * `returns.orderId` is NOT NULL, an unmatched row gets a clearly-flagged
 * PLACEHOLDER order + order item created for it (status/price/product are
 * placeholders -- see the row result's `orderCreated` flag and the order's
 * own `holdReason`) so the return still gets recorded as INITIATED and
 * stays scannable/receivable exactly like a normal return. Only runs when
 * the sheet's marketplace was confidently detected AND this company has
 * exactly one active seller account for it (ambiguous cases are left to
 * fail with the original "not found" error rather than guessing wrong).
 */
async function resolvePlaceholderAccountId(companyId: number, marketplace: "FLIPKART" | "MEESHO" | "SNAPDEAL" | null): Promise<number | null> {
  if (!marketplace) return null;
  const accounts = await db
    .select({ id: marketplaceAccounts.id })
    .from(marketplaceAccounts)
    .innerJoin(brands, eq(brands.id, marketplaceAccounts.brandId))
    .where(and(eq(brands.companyId, companyId), eq(marketplaceAccounts.marketplace, marketplace), eq(marketplaceAccounts.isActive, true)));
  return accounts.length === 1 ? accounts[0].id : null;
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

    // Some return exports (Snapdeal's, confirmed 2026-09-25) key their
    // "Suborder ID" column to the individual LINE ITEM, not the order --
    // matches order_items.marketplaceLineItemId (parseSnapdealExport stores
    // SUBORDERCODE there), never orders.marketplaceOrderId (ORDERCODE).
    // Without this fallback every row from that export style fails to match
    // any order at all, no matter how well the header itself is recognized.
    const lineItemRows = await db
      .select({
        lineItemId: orderItems.marketplaceLineItemId,
        orderId: orders.id,
        orderNo: orders.marketplaceOrderId,
        brand: brands.name,
        mp: marketplaceAccounts.marketplace,
      })
      .from(orderItems)
      .innerJoin(orders, eq(orders.id, orderItems.orderId))
      .innerJoin(marketplaceAccounts, eq(marketplaceAccounts.id, orders.marketplaceAccountId))
      .innerJoin(brands, eq(brands.id, marketplaceAccounts.brandId))
      .where(eq(brands.companyId, companyId));
    const byLineItemId = new Map(
      lineItemRows.filter((r) => r.lineItemId).map((r) => [r.lineItemId as string, { orderId: r.orderId, orderNo: r.orderNo, brand: r.brand, mp: r.mp }]),
    );

    // Resolved once per import (one CSV = one marketplace) -- see
    // resolvePlaceholderAccountId's doc comment for why this exists.
    const detectedMarketplace = detectMarketplace(Object.keys(records[0] ?? {}));
    const placeholderAccountId = await resolvePlaceholderAccountId(companyId, detectedMarketplace);

    const results: Array<Record<string, unknown>> = [];
    let imported = 0;
    let failed = 0;

    for (const [i, rec] of records.entries()) {
      const rowNo = i + 2; // header line offset
      const orderNo = pick(rec, ORDER_KEYS).replace(/^'/, "");
      const awb = pick(rec, AWB_KEYS) || null;
      const carrier = pick(rec, CARRIER_KEYS) || null;
      const rawReason = pick(rec, REASON_KEYS);
      const rawType = pick(rec, TYPE_KEYS);
      const returnType = classifyReturnType(rawType, rawReason);
      const reason = rawReason || null;
      const dateStr = pick(rec, DATE_KEYS);
      const initiatedAt = dateStr ? new Date(dateStr) : new Date();
      const receivedDateStr = pick(rec, RECEIVED_DATE_KEYS);
      const receivedAt = receivedDateStr ? new Date(receivedDateStr) : null;
      const receivedAtValid = receivedAt && !Number.isNaN(receivedAt.getTime()) ? receivedAt : null;

      try {
        if (!orderNo && !awb) throw new Error("Row has neither Order ID nor AWB");
        // Order-level match first (Order ID / Sub Order No columns that ARE
        // the order's own marketplace id); line-item match second (a
        // "Suborder ID" that's really the per-item SUBORDERCODE -- see
        // byLineItemId above).
        let match = orderNo ? byOrderNo.get(orderNo) ?? byLineItemId.get(orderNo) : undefined;
        let orderCreated = false;

        if (!match && orderNo && placeholderAccountId) {
          // The order genuinely isn't in the system yet, but we know which
          // seller account it belongs to (see resolvePlaceholderAccountId)
          // -- create a clearly-flagged placeholder so the return itself
          // isn't lost (see the big doc comment above this route for why).
          const [newOrder] = await db
            .insert(orders)
            .values({
              marketplaceAccountId: placeholderAccountId,
              marketplaceOrderId: orderNo,
              status: returnType === "RTO" ? "RTO_INITIATED" : "DELIVERED",
              orderedAt: Number.isNaN(initiatedAt.getTime()) ? new Date() : initiatedAt,
              holdReason: `Auto-created from a return-sheet import: the original order wasn't found in the system when this ${returnType === "RTO" ? "RTO" : "return"} was recorded. Order date is approximated from the return date; product/quantity/price are UNKNOWN placeholders -- verify against the marketplace seller panel and correct.`,
            })
            .onConflictDoNothing({ target: [orders.marketplaceAccountId, orders.marketplaceOrderId] })
            .returning({ id: orders.id });
          // onConflictDoNothing returns nothing on the (rare) race where a
          // concurrent upload created the same order a moment ago -- fetch
          // it instead of failing the row.
          const orderId = newOrder?.id ?? (await db.select({ id: orders.id }).from(orders).where(and(eq(orders.marketplaceAccountId, placeholderAccountId), eq(orders.marketplaceOrderId, orderNo))).limit(1))[0]?.id;
          if (orderId) {
            const [alreadyHasItem] = await db.select({ id: orderItems.id }).from(orderItems).where(eq(orderItems.orderId, orderId)).limit(1);
            if (!alreadyHasItem) {
              await db.insert(orderItems).values({
                orderId,
                marketplaceLineItemId: null,
                marketplaceSku: "UNKNOWN-RETURN-IMPORT",
                productTitleSnapshot: "Unknown — auto-created from return-sheet import, needs verification against the marketplace seller panel",
                quantity: 1,
                unitPrice: "0",
              });
            }
            // detectedMarketplace can't be null here: placeholderAccountId
            // only resolves (see resolvePlaceholderAccountId) when it isn't.
            match = { orderId, orderNo, brand: "", mp: detectedMarketplace! };
            orderCreated = true;
          }
        }

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
              returnType: returnType ?? undefined,
              reason: reason ?? undefined,
              initiatedAt: Number.isNaN(initiatedAt.getTime()) ? undefined : initiatedAt,
            })
            .where(eq(returns.id, existing.id));
          // Same RTO auto-sync as a brand-new return (see initiateReturn) --
          // a re-uploaded sheet can be the first time the classification
          // resolves to RTO (e.g. the reason text only became recognizable
          // on a later sheet), so this has to run on the update path too,
          // not just on first insert.
          if (returnType === "RTO") {
            await db
              .update(orders)
              .set({ status: "RTO_INITIATED" })
              .where(and(eq(orders.id, match.orderId), inArray(orders.status, ["CREATED", "READY_TO_DISPATCH", "DISPATCHED", "ON_HOLD"])));
          }
          // The portal already reports this one delivered -- record it
          // instead of waiting for a floor scan that may never happen for
          // an already-old/completed return being backfilled in bulk.
          if (receivedAtValid) await markReturnReceived(existing.id, receivedAtValid);
          results.push({
            row: rowNo,
            order: orderNo,
            returnId: existing.id,
            returnType,
            updated: true,
            received: Boolean(receivedAtValid),
            orderCreated,
            ...(orderCreated ? { warning: "Order wasn't in the system — created as a placeholder (product/price unknown). Verify it against the seller panel." } : {}),
          });
        } else {
          const { returnId } = await initiateReturn({
            orderId: match.orderId,
            reverseAwb: awb ?? undefined,
            reverseCarrier: carrier ?? undefined,
            returnType,
            reason,
            initiatedAt: Number.isNaN(initiatedAt.getTime()) ? new Date() : initiatedAt,
          });
          if (receivedAtValid) await markReturnReceived(returnId, receivedAtValid);
          results.push({
            row: rowNo,
            order: orderNo,
            returnId,
            returnType,
            created: true,
            brand: match.brand,
            marketplace: match.mp,
            received: Boolean(receivedAtValid),
            orderCreated,
            ...(orderCreated ? { warning: "Order wasn't in the system — created as a placeholder (product/price unknown). Verify it against the seller panel." } : {}),
          });
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
//
// Cross-company by design, same as dispatch.ts's pack scan (2026-09-25,
// user request): "esa hi return me ho, nahi to pata nahi chalega konsi
// company ya brand ka hai" — one return-receive station for every
// company/brand this person has returns access to, no company switch first,
// and the matched company/brand is always named back so it's never
// ambiguous. scannableCompanyIds() is the same trust boundary the pack-scan
// route uses.
// ---------------------------------------------------------------------------

const scanSchema = z.object({ code: z.string().trim().min(3).max(120) });

returnsRouter.post("/scan", requireRole("OWNER", "ADMIN", "OPS"), async (req, res, next) => {
  try {
    const body = scanSchema.parse(req.body);
    const companyIds = await scannableCompanyIds(req.session!.userId, "returns");
    if (!companyIds.length) throw new HttpError(403, "No returns access in any company");
    const code = body.code;

    const rows = await db
      .select({
        returnId: returns.id,
        status: returns.status,
        reverseAwb: returns.reverseAwb,
        deliveredAt: returns.deliveredAt,
        orderNo: orders.marketplaceOrderId,
        brand: brands.name,
        companyName: companies.displayName,
        marketplace: marketplaceAccounts.marketplace,
        skuCode: skus.code,
      })
      .from(returns)
      .innerJoin(orders, eq(orders.id, returns.orderId))
      .innerJoin(marketplaceAccounts, eq(marketplaceAccounts.id, orders.marketplaceAccountId))
      .innerJoin(brands, eq(brands.id, marketplaceAccounts.brandId))
      .innerJoin(companies, eq(companies.id, brands.companyId))
      .leftJoin(orderItems, eq(orderItems.orderId, orders.id))
      .leftJoin(skus, eq(skus.id, orderItems.skuId))
      .where(
        and(
          inArray(brands.companyId, companyIds),
          inArray(returns.status, ["INITIATED", "IN_TRANSIT"]),
          code.includes("-") ? eq(orders.marketplaceOrderId, code) : eq(returns.reverseAwb, code)
        )
      )
      .limit(1);

    const found = rows[0];
    if (!found) {
      throw new HttpError(404, `No open return matches "${code}" in any company you have returns access to — upload the return sheet first if this is a new return`);
    }

    await markReturnReceived(found.returnId, new Date());

    res.json({
      returnId: found.returnId,
      order: found.orderNo,
      company: found.companyName,
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
        returnType: returns.returnType,
        reason: returns.reason,
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

// ---------------------------------------------------------------------------
// RETURNS TRACKING — the "Upcoming Returns / Pending" + "Expected vs
// Received" report the floor already tracks by hand (user request,
// 2026-09-25: "return initiate hua hai to next 5 din me apne pass receive
// ho jana chahiye, ek column Expected Return Date ka bhi banega"). One
// endpoint carries every field either view needs; the frontend renders two
// tabs from it rather than this needing two separate queries.
//
// EXPECTED_RETURN_WINDOW_DAYS is a flat 5-day rule per the user's own
// words -- not marketplace/courier-specific. If that turns out to need to
// vary (e.g. by courier), this is the one place to make it a lookup instead
// of a constant.
// ---------------------------------------------------------------------------

export const EXPECTED_RETURN_WINDOW_DAYS = 5;

returnsRouter.get("/tracking", async (req, res, next) => {
  try {
    const companyId = req.session!.companyId;
    // ?pending=1 -- only returns not yet received (the "Upcoming Returns"
    // view); omitted -- everything, for "Expected vs Received".
    const pendingOnly = req.query.pending === "1" || req.query.pending === "true";

    const rows = await db
      .select({
        id: returns.id,
        status: returns.status,
        orderNo: orders.marketplaceOrderId,
        brand: brands.name,
        marketplace: marketplaceAccounts.marketplace,
        dispatchAwb: shipments.awbNumber,
        returnAwb: returns.reverseAwb,
        initiatedAt: returns.initiatedAt,
        deliveredAt: returns.deliveredAt,
        expectedReturnDate: sql<string>`(${returns.initiatedAt} + interval '${sql.raw(String(EXPECTED_RETURN_WINDOW_DAYS))} days')`,
        dueStatus: sql<string>`
          CASE
            WHEN ${returns.deliveredAt} IS NOT NULL
                 AND ${returns.deliveredAt} <= (${returns.initiatedAt} + interval '${sql.raw(String(EXPECTED_RETURN_WINDOW_DAYS))} days')
              THEN 'RECEIVED_ON_TIME'
            WHEN ${returns.deliveredAt} IS NOT NULL THEN 'RECEIVED_LATE'
            WHEN now() > (${returns.initiatedAt} + interval '${sql.raw(String(EXPECTED_RETURN_WINDOW_DAYS))} days') THEN 'OVERDUE'
            ELSE 'DUE'
          END
        `,
      })
      .from(returns)
      .innerJoin(orders, eq(orders.id, returns.orderId))
      .innerJoin(marketplaceAccounts, eq(marketplaceAccounts.id, orders.marketplaceAccountId))
      .innerJoin(brands, eq(brands.id, marketplaceAccounts.brandId))
      .leftJoin(shipments, eq(shipments.orderId, orders.id))
      .where(and(eq(brands.companyId, companyId), pendingOnly ? sql`${returns.deliveredAt} IS NULL` : undefined))
      .orderBy(desc(returns.initiatedAt))
      .limit(1000);

    res.json(rows);
  } catch (err) {
    next(err);
  }
});
