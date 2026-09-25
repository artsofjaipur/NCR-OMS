import { Router } from "express";
import { and, desc, eq, inArray, sql } from "drizzle-orm";
import { z } from "zod";
import { db } from "../db/client";
import { brands, orders, orderItems, warehouses, marketplaceAccounts, marketplaceSkuMap, skus, returns, shipments } from "../db/schema";
import { requireAuth, requireCompanyScope } from "../middleware/auth";
import { requireSection } from "../security/permissions";
import { HttpError } from "../middleware/errorHandler";
import { parseFlipkartExport } from "../ingestion/parsers/flipkart";
import { parseMeeshoExport } from "../ingestion/parsers/meesho";
import { parseSnapdealExport } from "../ingestion/parsers/snapdeal";
import { ingestOrder, UnmappedSkuError } from "../modules/orders/ingest";
import { InsufficientStockError } from "../modules/inventory/ledger";
import { EXPECTED_RETURN_WINDOW_DAYS } from "./returns";

export const dashboardRouter = Router();
dashboardRouter.use(requireAuth, requireCompanyScope);

/**
 * One round-trip for the dashboard's first paint: brands, warehouses,
 * marketplace accounts, KPIs, a 14-day order trend and a per-marketplace
 * split. Revenue = sum of line-item invoice amounts (orders table itself has
 * no monetary column).
 */
dashboardRouter.get("/summary", async (req, res, next) => {
  try {
    const companyId = req.session!.companyId;

    const brandRows = await db
      .select({ id: brands.id, name: brands.name })
      .from(brands)
      .where(eq(brands.companyId, companyId))
      .orderBy(brands.id);

    const warehouseRows = await db
      .select({ id: warehouses.id, name: warehouses.name, isDefault: warehouses.isDefault })
      .from(warehouses)
      .where(eq(warehouses.companyId, companyId))
      .orderBy(desc(warehouses.isDefault), warehouses.id);

    const accounts = await db
      .select({
        id: marketplaceAccounts.id,
        brandId: marketplaceAccounts.brandId,
        marketplace: marketplaceAccounts.marketplace,
        sellerAccountLabel: marketplaceAccounts.sellerAccountLabel,
        isActive: marketplaceAccounts.isActive,
      })
      .from(marketplaceAccounts)
      .innerJoin(brands, eq(brands.id, marketplaceAccounts.brandId))
      .where(eq(brands.companyId, companyId));

    const accountIds = accounts.map((a) => a.id);

    const kpis = {
      ordersToday: 0,
      ordersTotal: 0,
      pendingDispatch: 0,
      returnsOpen: 0,
      revenueToday: "0",
      gmvTotal: "0",
    };

    if (accountIds.length > 0) {
      const scope = inArray(orders.marketplaceAccountId, accountIds);

      const [todayRow] = await db
        .select({
          count: sql<number>`count(distinct ${orders.id})::int`,
          revenue: sql<string>`coalesce(sum(${orderItems.invoiceAmount}), 0)::text`,
        })
        .from(orders)
        .leftJoin(orderItems, eq(orderItems.orderId, orders.id))
        .where(and(scope, sql`${orders.orderedAt} >= date_trunc('day', now())`));

      const [totalRow] = await db
        .select({
          count: sql<number>`count(distinct ${orders.id})::int`,
          gmv: sql<string>`coalesce(sum(${orderItems.invoiceAmount}), 0)::text`,
        })
        .from(orders)
        .leftJoin(orderItems, eq(orderItems.orderId, orders.id))
        .where(scope);

      const [pendingRow] = await db
        .select({ count: sql<number>`count(*)::int` })
        .from(orders)
        .where(
          and(
            scope,
            sql`${orders.status} in ('READY_TO_DISPATCH','CREATED')`
          )
        );

      const [returnsRow] = await db
        .select({ count: sql<number>`count(*)::int` })
        .from(returns)
        .innerJoin(orders, eq(orders.id, returns.orderId))
        .innerJoin(marketplaceAccounts, eq(marketplaceAccounts.id, orders.marketplaceAccountId))
        .innerJoin(brands, eq(brands.id, marketplaceAccounts.brandId))
        .where(
          and(
            eq(brands.companyId, companyId),
            sql`${returns.status} not in ('RESTOCKED','CLOSED')`
          )
        );

      kpis.ordersToday = todayRow?.count ?? 0;
      kpis.ordersTotal = totalRow?.count ?? 0;
      kpis.pendingDispatch = pendingRow?.count ?? 0;
      kpis.returnsOpen = returnsRow?.count ?? 0;
      kpis.revenueToday = todayRow?.revenue ?? "0";
      kpis.gmvTotal = totalRow?.gmv ?? "0";

      // ---- 14-day trend (order count + revenue per day) ----
      const trendRows = await db
        .select({
          day: sql<string>`to_char(date_trunc('day', ${orders.orderedAt}), 'YYYY-MM-DD')`,
          count: sql<number>`count(distinct ${orders.id})::int`,
          revenue: sql<string>`coalesce(sum(${orderItems.invoiceAmount}), 0)::text`,
        })
        .from(orders)
        .leftJoin(orderItems, eq(orderItems.orderId, orders.id))
        .where(
          and(
            scope,
            sql`${orders.orderedAt} >= date_trunc('day', now()) - interval '13 days'`
          )
        )
        .groupBy(sql`date_trunc('day', ${orders.orderedAt})`)
        .orderBy(sql`date_trunc('day', ${orders.orderedAt})`);
      void trendRows;

      // ---- per-marketplace split ----
      const byMarketplace = await db
        .select({
          marketplace: marketplaceAccounts.marketplace,
          orders: sql<number>`count(distinct ${orders.id})::int`,
          revenue: sql<string>`coalesce(sum(${orderItems.invoiceAmount}), 0)::text`,
        })
        .from(orders)
        .innerJoin(marketplaceAccounts, eq(marketplaceAccounts.id, orders.marketplaceAccountId))
        .leftJoin(orderItems, eq(orderItems.orderId, orders.id))
        .where(scope)
        .groupBy(marketplaceAccounts.marketplace);

      res.json({
        brands: brandRows,
        warehouses: warehouseRows,
        accounts,
        kpis,
        trend: trendRows,
        byMarketplace,
      });
      return;
    }

    res.json({ brands: brandRows, warehouses: warehouseRows, accounts, kpis, trend: [], byMarketplace: [] });
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------------------
// Daily Summary panel — user's spec (Hinglish, 2026-09-25), verbatim:
//   "DASHBOARD — Daily Summary / OVERALL TOTALS (dispatched orders+amount,
//    returns expected/received/pending, due today, overdue) /
//    PLATFORM-WISE BREAKDOWN (platform x dispatched/amount/returns received) /
//    DAILY SUMMARY (date x dispatched/returns expected/returns received) /
//    order dispatch return expected returns recived link rahe click karne
//    par pata chal jana chahiye ki aaj ye order dispatch huye unki list
//    dikh jaye, ese hi return vali"
// -- i.e. every count below must be clickable and open the underlying row
// list. GET /daily-summary computes the three blocks; GET
// /daily-summary/detail is what each click calls to fetch that list
// (frontend: public/app.js, window.NcrModal).
//
// ASSUMPTION (disclosed to the user, not silently guessed): "Orders
// Dispatched" = shipments.packed_at IS NOT NULL. Nothing in this codebase
// auto-transitions an order to the DISPATCHED status -- that enum value is
// only ever set by a manual PATCH edit (grep confirms no other write site),
// same mechanism as Cancel. The Scan Station's pack-scan (packedAt) is the
// only automatic "this order left the building" signal that exists today,
// and it's already what the Scan Station's "scanned today" counter and the
// Orders page's "Packed" badge use -- so this panel stays consistent with
// what's shown everywhere else rather than inventing a second definition.
// If a manual-only "mark Dispatched" flow should also count, this is the
// one place to widen the condition (OR in orders.status = 'DISPATCHED').
//
// "Total Returns Expected" (OVERALL TOTALS) = every return ever initiated
// (initiated_at not null), matching the "Expected vs Received" tracking
// view's full row count. The DAILY SUMMARY table's per-day "Returns
// Expected" is different on purpose -- it buckets by EXPECTED return date
// (initiated_at + 5 days), i.e. "how many are due back on this date", not
// "how many were initiated on this date".
// ---------------------------------------------------------------------------

const DAILY_SUMMARY_METRICS = [
  "ordersDispatched",
  "dispatchAmount",
  "returnsExpected",
  "returnsReceived",
  "returnsPending",
  "returnsDueToday",
  "returnsOverdue",
] as const;
type DailySummaryMetric = (typeof DAILY_SUMMARY_METRICS)[number];

const ORDER_METRICS = new Set<DailySummaryMetric>(["ordersDispatched", "dispatchAmount"]);

const dailySummaryQuerySchema = z.object({
  days: z.coerce.number().int().min(1).max(180).optional(),
});

dashboardRouter.get("/daily-summary", async (req, res, next) => {
  try {
    const companyId = req.session!.companyId;
    const parsedQuery = dailySummaryQuerySchema.safeParse(req.query);
    const days = parsedQuery.success && parsedQuery.data.days ? parsedQuery.data.days : 30;

    const accountRows = await db
      .select({ id: marketplaceAccounts.id })
      .from(marketplaceAccounts)
      .innerJoin(brands, eq(brands.id, marketplaceAccounts.brandId))
      .where(eq(brands.companyId, companyId));
    const accountIds = accountRows.map((a) => a.id);

    const empty = {
      totals: {
        ordersDispatched: 0,
        dispatchAmount: "0",
        returnsExpected: 0,
        returnsReceived: 0,
        returnsPending: 0,
        returnsDueToday: 0,
        returnsOverdue: 0,
      },
      byPlatform: [] as Array<{ marketplace: string; ordersDispatched: number; dispatchAmount: string; returnsReceived: number }>,
      byDate: [] as Array<{ date: string; ordersDispatched: number; returnsExpected: number; returnsReceived: number }>,
    };

    if (accountIds.length === 0) {
      res.json(empty);
      return;
    }

    const scope = inArray(orders.marketplaceAccountId, accountIds);
    const dispatchedScope = and(
      scope,
      sql`exists (select 1 from ${shipments} where ${shipments.orderId} = ${orders.id} and ${shipments.packedAt} is not null)`
    );

    const [dispatchedRow] = await db
      .select({
        count: sql<number>`count(distinct ${orders.id})::int`,
        amount: sql<string>`coalesce(sum(${orderItems.invoiceAmount}), 0)::text`,
      })
      .from(orders)
      .leftJoin(orderItems, eq(orderItems.orderId, orders.id))
      .where(dispatchedScope);

    const [returnsRow] = await db
      .select({
        expected: sql<number>`count(*)::int`,
        received: sql<number>`count(*) filter (where ${returns.deliveredAt} is not null)::int`,
        pending: sql<number>`count(*) filter (where ${returns.deliveredAt} is null)::int`,
        dueToday: sql<number>`count(*) filter (
          where ${returns.deliveredAt} is null
            and date_trunc('day', ${returns.initiatedAt} + interval '${sql.raw(String(EXPECTED_RETURN_WINDOW_DAYS))} days') = date_trunc('day', now())
        )::int`,
        // Day-level (not instant-level) comparison so a return whose 5-day
        // deadline is *today* counts as dueToday, not both dueToday AND
        // overdue depending on what second of today it currently is.
        overdue: sql<number>`count(*) filter (
          where ${returns.deliveredAt} is null
            and date_trunc('day', ${returns.initiatedAt} + interval '${sql.raw(String(EXPECTED_RETURN_WINDOW_DAYS))} days') < date_trunc('day', now())
        )::int`,
      })
      .from(returns)
      .innerJoin(orders, eq(orders.id, returns.orderId))
      .innerJoin(marketplaceAccounts, eq(marketplaceAccounts.id, orders.marketplaceAccountId))
      .innerJoin(brands, eq(brands.id, marketplaceAccounts.brandId))
      .where(and(eq(brands.companyId, companyId), sql`${returns.initiatedAt} is not null`));

    const totals = {
      ordersDispatched: dispatchedRow?.count ?? 0,
      dispatchAmount: dispatchedRow?.amount ?? "0",
      returnsExpected: returnsRow?.expected ?? 0,
      returnsReceived: returnsRow?.received ?? 0,
      returnsPending: returnsRow?.pending ?? 0,
      returnsDueToday: returnsRow?.dueToday ?? 0,
      returnsOverdue: returnsRow?.overdue ?? 0,
    };

    // ---- platform-wise breakdown ----
    const platformDispatch = await db
      .select({
        marketplace: marketplaceAccounts.marketplace,
        ordersDispatched: sql<number>`count(distinct ${orders.id})::int`,
        dispatchAmount: sql<string>`coalesce(sum(${orderItems.invoiceAmount}), 0)::text`,
      })
      .from(orders)
      .innerJoin(marketplaceAccounts, eq(marketplaceAccounts.id, orders.marketplaceAccountId))
      .leftJoin(orderItems, eq(orderItems.orderId, orders.id))
      .where(dispatchedScope)
      .groupBy(marketplaceAccounts.marketplace);

    const platformReturns = await db
      .select({
        marketplace: marketplaceAccounts.marketplace,
        returnsReceived: sql<number>`count(*)::int`,
      })
      .from(returns)
      .innerJoin(orders, eq(orders.id, returns.orderId))
      .innerJoin(marketplaceAccounts, eq(marketplaceAccounts.id, orders.marketplaceAccountId))
      .innerJoin(brands, eq(brands.id, marketplaceAccounts.brandId))
      .where(and(eq(brands.companyId, companyId), sql`${returns.deliveredAt} is not null`))
      .groupBy(marketplaceAccounts.marketplace);

    const platformMap = new Map<
      string,
      { marketplace: string; ordersDispatched: number; dispatchAmount: string; returnsReceived: number }
    >();
    for (const row of platformDispatch) {
      platformMap.set(row.marketplace, {
        marketplace: row.marketplace,
        ordersDispatched: row.ordersDispatched,
        dispatchAmount: row.dispatchAmount,
        returnsReceived: 0,
      });
    }
    for (const row of platformReturns) {
      const existing = platformMap.get(row.marketplace);
      if (existing) existing.returnsReceived = row.returnsReceived;
      else platformMap.set(row.marketplace, { marketplace: row.marketplace, ordersDispatched: 0, dispatchAmount: "0", returnsReceived: row.returnsReceived });
    }
    const byPlatform = Array.from(platformMap.values()).sort((a, b) => a.marketplace.localeCompare(b.marketplace));

    // ---- per-day trend, last `days` days including today ----
    const dispatchedByDay = await db
      .select({
        day: sql<string>`to_char(date_trunc('day', ${shipments.packedAt}), 'YYYY-MM-DD')`,
        count: sql<number>`count(distinct ${orders.id})::int`,
      })
      .from(orders)
      .innerJoin(shipments, and(eq(shipments.orderId, orders.id), sql`${shipments.packedAt} is not null`))
      .where(and(scope, sql`${shipments.packedAt} >= date_trunc('day', now()) - interval '${sql.raw(String(days - 1))} days'`))
      .groupBy(sql`date_trunc('day', ${shipments.packedAt})`);

    const returnsExpectedByDay = await db
      .select({
        day: sql<string>`to_char(date_trunc('day', ${returns.initiatedAt} + interval '${sql.raw(String(EXPECTED_RETURN_WINDOW_DAYS))} days'), 'YYYY-MM-DD')`,
        count: sql<number>`count(*)::int`,
      })
      .from(returns)
      .innerJoin(orders, eq(orders.id, returns.orderId))
      .innerJoin(marketplaceAccounts, eq(marketplaceAccounts.id, orders.marketplaceAccountId))
      .innerJoin(brands, eq(brands.id, marketplaceAccounts.brandId))
      .where(
        and(
          eq(brands.companyId, companyId),
          sql`${returns.initiatedAt} is not null`,
          sql`(${returns.initiatedAt} + interval '${sql.raw(String(EXPECTED_RETURN_WINDOW_DAYS))} days') >= date_trunc('day', now()) - interval '${sql.raw(String(days - 1))} days'`
        )
      )
      .groupBy(sql`date_trunc('day', ${returns.initiatedAt} + interval '${sql.raw(String(EXPECTED_RETURN_WINDOW_DAYS))} days')`);

    const returnsReceivedByDay = await db
      .select({
        day: sql<string>`to_char(date_trunc('day', ${returns.deliveredAt}), 'YYYY-MM-DD')`,
        count: sql<number>`count(*)::int`,
      })
      .from(returns)
      .innerJoin(orders, eq(orders.id, returns.orderId))
      .innerJoin(marketplaceAccounts, eq(marketplaceAccounts.id, orders.marketplaceAccountId))
      .innerJoin(brands, eq(brands.id, marketplaceAccounts.brandId))
      .where(
        and(
          eq(brands.companyId, companyId),
          sql`${returns.deliveredAt} is not null`,
          sql`${returns.deliveredAt} >= date_trunc('day', now()) - interval '${sql.raw(String(days - 1))} days'`
        )
      )
      .groupBy(sql`date_trunc('day', ${returns.deliveredAt})`);

    const dispatchedMap = new Map(dispatchedByDay.map((r) => [r.day, r.count]));
    const expectedMap = new Map(returnsExpectedByDay.map((r) => [r.day, r.count]));
    const receivedMap = new Map(returnsReceivedByDay.map((r) => [r.day, r.count]));

    const byDate: typeof empty.byDate = [];
    const today = new Date();
    for (let i = 0; i < days; i++) {
      const d = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate() - i));
      const key = d.toISOString().slice(0, 10);
      byDate.push({
        date: key,
        ordersDispatched: dispatchedMap.get(key) ?? 0,
        returnsExpected: expectedMap.get(key) ?? 0,
        returnsReceived: receivedMap.get(key) ?? 0,
      });
    }

    res.json({ totals, byPlatform, byDate });
  } catch (err) {
    next(err);
  }
});

const dailySummaryDetailQuerySchema = z.object({
  metric: z.enum(DAILY_SUMMARY_METRICS),
  date: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, "date must be YYYY-MM-DD")
    .optional(),
  platform: z.string().optional(),
});

/**
 * The drill-down behind every clickable number in the Daily Summary panel.
 * ?metric= picks which count; ?date= narrows to one day (Daily Summary
 * table clicks); ?platform= narrows to one marketplace (Platform-wise
 * Breakdown clicks). Neither given = the Overall Totals figure, all-time.
 */
dashboardRouter.get("/daily-summary/detail", async (req, res, next) => {
  try {
    const companyId = req.session!.companyId;
    const parsed = dailySummaryDetailQuerySchema.safeParse(req.query);
    if (!parsed.success) {
      throw new HttpError(400, "Invalid daily-summary detail request.");
    }
    const { metric, date, platform } = parsed.data;

    const accountRows = await db
      .select({ id: marketplaceAccounts.id })
      .from(marketplaceAccounts)
      .innerJoin(brands, eq(brands.id, marketplaceAccounts.brandId))
      .where(eq(brands.companyId, companyId));
    const accountIds = accountRows.map((a) => a.id);

    if (accountIds.length === 0) {
      res.json({ kind: ORDER_METRICS.has(metric) ? "orders" : "returns", rows: [] });
      return;
    }

    if (ORDER_METRICS.has(metric)) {
      const scope = inArray(orders.marketplaceAccountId, accountIds);
      const conditions = [
        scope,
        sql`exists (select 1 from ${shipments} where ${shipments.orderId} = ${orders.id} and ${shipments.packedAt} is not null)`,
      ];
      if (date) {
        conditions.push(
          sql`exists (select 1 from ${shipments} where ${shipments.orderId} = ${orders.id} and date_trunc('day', ${shipments.packedAt}) = ${date}::date)`
        );
      }
      if (platform) conditions.push(sql`${marketplaceAccounts.marketplace} = ${platform}`);

      const rows = await db
        .select({
          orderId: orders.id,
          orderNo: orders.marketplaceOrderId,
          brand: brands.name,
          marketplace: marketplaceAccounts.marketplace,
          status: orders.status,
          dispatchedAt: shipments.packedAt,
          awbNumber: shipments.awbNumber,
          invoiceAmount: sql<string>`coalesce(sum(${orderItems.invoiceAmount}), 0)::text`,
        })
        .from(orders)
        .innerJoin(marketplaceAccounts, eq(marketplaceAccounts.id, orders.marketplaceAccountId))
        .innerJoin(brands, eq(brands.id, marketplaceAccounts.brandId))
        .leftJoin(shipments, eq(shipments.orderId, orders.id))
        .leftJoin(orderItems, eq(orderItems.orderId, orders.id))
        .where(and(...conditions))
        .groupBy(orders.id, orders.marketplaceOrderId, brands.name, marketplaceAccounts.marketplace, orders.status, shipments.packedAt, shipments.awbNumber)
        .orderBy(desc(shipments.packedAt))
        .limit(500);

      res.json({ kind: "orders", rows });
      return;
    }

    // ---- returns-based metrics ----
    const conditions = [eq(brands.companyId, companyId), sql`${returns.initiatedAt} is not null`];
    if (platform) conditions.push(sql`${marketplaceAccounts.marketplace} = ${platform}`);

    if (metric === "returnsReceived") {
      conditions.push(sql`${returns.deliveredAt} is not null`);
      if (date) conditions.push(sql`date_trunc('day', ${returns.deliveredAt}) = ${date}::date`);
    } else if (metric === "returnsPending") {
      conditions.push(sql`${returns.deliveredAt} is null`);
    } else if (metric === "returnsDueToday") {
      conditions.push(sql`${returns.deliveredAt} is null`);
      conditions.push(sql`date_trunc('day', ${returns.initiatedAt} + interval '${sql.raw(String(EXPECTED_RETURN_WINDOW_DAYS))} days') = date_trunc('day', now())`);
    } else if (metric === "returnsOverdue") {
      conditions.push(sql`${returns.deliveredAt} is null`);
      // Day-level, matching the /daily-summary totals aggregate — see its
      // own comment on why this isn't `now() > expected`.
      conditions.push(sql`date_trunc('day', ${returns.initiatedAt} + interval '${sql.raw(String(EXPECTED_RETURN_WINDOW_DAYS))} days') < date_trunc('day', now())`);
    } else if (metric === "returnsExpected" && date) {
      conditions.push(sql`date_trunc('day', ${returns.initiatedAt} + interval '${sql.raw(String(EXPECTED_RETURN_WINDOW_DAYS))} days') = ${date}::date`);
    }

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
        // Day-level OVERDUE cutoff here (not the instant-level `now() >
        // expected` that /returns/tracking's own dueStatus uses) so a row
        // pulled up by clicking "Returns Due TODAY" never shows an
        // OVERDUE badge just because a few seconds of today have already
        // ticked past its exact deadline -- it needs to stay consistent
        // with the day-bucketed dueToday/overdue counts right above.
        dueStatus: sql<string>`
          CASE
            WHEN ${returns.deliveredAt} IS NOT NULL
                 AND ${returns.deliveredAt} <= (${returns.initiatedAt} + interval '${sql.raw(String(EXPECTED_RETURN_WINDOW_DAYS))} days')
              THEN 'RECEIVED_ON_TIME'
            WHEN ${returns.deliveredAt} IS NOT NULL THEN 'RECEIVED_LATE'
            WHEN date_trunc('day', ${returns.initiatedAt} + interval '${sql.raw(String(EXPECTED_RETURN_WINDOW_DAYS))} days') < date_trunc('day', now()) THEN 'OVERDUE'
            ELSE 'DUE'
          END
        `,
      })
      .from(returns)
      .innerJoin(orders, eq(orders.id, returns.orderId))
      .innerJoin(marketplaceAccounts, eq(marketplaceAccounts.id, orders.marketplaceAccountId))
      .innerJoin(brands, eq(brands.id, marketplaceAccounts.brandId))
      .leftJoin(shipments, eq(shipments.orderId, orders.id))
      .where(and(...conditions))
      .orderBy(desc(returns.initiatedAt))
      .limit(500);

    res.json({ kind: "returns", rows });
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------------------
// Google Sheet import — the same Flipkart/Meesho/Snapdeal parsers as the
// manual CSV upload, fed straight from a shared ("Anyone with the link")
// Google Sheet's CSV export. The fetch happens server-side so the user just
// pastes a normal /edit link; gid (the specific tab) is honored.
// ---------------------------------------------------------------------------

/** Extract the spreadsheet id and optional gid from any Google Sheets URL form. */
export function parseSheetUrl(rawUrl: string): { spreadsheetId: string; gid: string | null } {
  const match = rawUrl.match(/spreadsheets\/d\/([a-zA-Z0-9-_]+)/);
  if (!match) {
    throw new HttpError(400, "Ye Google Sheet ka link nahi lag raha — /spreadsheets/d/... wala pura link paste karein.");
  }
  let gid: string | null = null;
  const gidMatch = rawUrl.match(/[#&?]gid=([0-9]+)/);
  if (gidMatch) gid = gidMatch[1];
  return { spreadsheetId: match[1], gid };
}

/** Header-signature sniffing — which marketplace's export is this CSV? */
export function detectMarketplace(csvText: string): "flipkart" | "meesho" | "snapdeal" {
  const head = csvText.slice(0, 4000).toLowerCase();
  if (head.includes("sub order no") || head.includes("supplier discounted price")) return "meesho";
  if (head.includes("ordercode") || head.includes("subordercode")) return "snapdeal";
  if (head.includes("order id") && (head.includes("order state") || head.includes("sku"))) return "flipkart";
  throw new HttpError(400, "Sheet ka format pehchana nahi ja raha — sirf Flipkart / Meesho / Snapdeal order-export columns supported hain.");
}

const sheetImportSchema = z
  .object({
    // Required unless the CSV itself is posted (pasted-CSV fallback needs no link).
    sheetUrl: z.string().optional(),
    // Optional browser-fetched CSV: when the server's own egress to Google is
    // blocked (strict corporate/sandbox networks), the panel fetches the CSV
    // export from the *user's browser* and posts it along — the same parsers
    // run either way. Capped at 20 MB, far above any realistic order export.
    sheetCsv: z.string().max(20_000_000).optional(),
    marketplaceAccountId: z.number().int().positive(),
    warehouseId: z.number().int().positive(),
  })
  .refine((b) => Boolean((b.sheetCsv && b.sheetCsv.trim()) || (b.sheetUrl && b.sheetUrl.trim())), {
    message: "Sheet link ya CSV content — kuch ek zaroori hai",
  });

// ---------------------------------------------------------------------------
// Auto-detect: which of the caller's marketplace accounts does this sheet
// belong to? The same header sniff picks the marketplace, then the sheet's
// actual SKU strings are matched against that account's SKU mappings — a
// hit-rate decides the best candidate. Same fetch fallback chain as the
// import route (browser CSV → server fetch), so detection works everywhere
// the import itself does.
// ---------------------------------------------------------------------------

const detectSchema = z
  .object({
    sheetUrl: z.string().optional(),
    sheetCsv: z.string().max(20_000_000).optional(),
  })
  .refine((b) => Boolean((b.sheetCsv && b.sheetCsv.trim()) || (b.sheetUrl && b.sheetUrl.trim())), {
    message: "Sheet link ya CSV content — kuch ek zaroori hai",
  });

dashboardRouter.post("/google-sheet/detect", requireSection("orders"), async (req, res, next) => {
  try {
    const body = detectSchema.parse(req.body);
    const companyId = req.session!.companyId;

    // --- get CSV text (identical fallback chain to the import route) ---
    let csvText: string;
    if (body.sheetCsv && body.sheetCsv.trim().length > 0) {
      csvText = body.sheetCsv;
    } else {
      const { spreadsheetId, gid } = parseSheetUrl(body.sheetUrl as string);
      const exportUrl =
        `https://docs.google.com/spreadsheets/d/${spreadsheetId}/export?format=csv` +
        (gid ? `&gid=${gid}` : "");
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 25000);
      try {
        const resp = await fetch(exportUrl, {
          redirect: "follow",
          signal: controller.signal,
          headers: { "User-Agent": "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36" },
        });
        if (!resp.ok) {
          if (resp.status === 404 || resp.status === 401 || resp.status === 403) {
            throw new HttpError(400, "Sheet open nahi ho payi — 'Anyone with the link (Viewer)' sharing on karein.");
          }
          throw new HttpError(502, `Google se CSV download fail hua (HTTP ${resp.status}).`);
        }
        const ct = resp.headers.get("content-type") || "";
        csvText = await resp.text();
        if (ct.includes("text/html") || csvText.trimStart().startsWith("<!DOCTYPE html")) {
          throw new HttpError(400, "Sheet public nahi hai — Share → 'Anyone with the link' (Viewer) on karein.");
        }
      } catch (err) {
        if (err instanceof HttpError) throw err;
        if (err && typeof err === "object" && (err as { name?: string }).name === "AbortError") {
          throw new HttpError(504, "Google se data laane me time out ho gaya — thodi der baad dobara try karein.");
        }
        throw new HttpError(502, "Google Sheet tak request pahunchi hi nahi — network/URL check karein.");
      } finally {
        clearTimeout(timeout);
      }
    }

    if (csvText.trim().length === 0) {
      throw new HttpError(400, "Sheet khali hai ya gid (tab) galat hai.");
    }

    const marketplace = detectMarketplace(csvText);
    const parser =
      marketplace === "flipkart" ? parseFlipkartExport : marketplace === "meesho" ? parseMeeshoExport : parseSnapdealExport;
    let marketplaceSkus: string[];
    try {
      const normalizedOrders = parser(csvText);
      marketplaceSkus = normalizedOrders
        .flatMap((o) => o.items.map((i) => i.marketplaceSku))
        .filter((s) => typeof s === "string" && s.trim().length > 0);
    } catch (err) {
      throw new HttpError(400, `Sheet parse nahi ho payi (${marketplace} format): ${err instanceof Error ? err.message : "unknown error"}`);
    }

    const distinctSkus = [...new Set(marketplaceSkus.map((s) => s.trim()))].slice(0, 200);
    if (distinctSkus.length === 0) {
      throw new HttpError(400, "Sheet me koi SKU nahi mili — rows khali hain ya SKU column missing hai.");
    }

    // Caller's accounts, newest last for stable ordering.
    const accounts = await db
      .select({
        id: marketplaceAccounts.id,
        marketplace: marketplaceAccounts.marketplace,
        sellerAccountLabel: marketplaceAccounts.sellerAccountLabel,
        brandId: brands.id,
        brandName: brands.name,
      })
      .from(marketplaceAccounts)
      .innerJoin(brands, eq(brands.id, marketplaceAccounts.brandId))
      .where(and(eq(brands.companyId, companyId), eq(marketplaceAccounts.isActive, true)))
      .orderBy(marketplaceAccounts.id);

    if (accounts.length === 0) {
      throw new HttpError(400, "Koi active seller account nahi mila — pehle Brands & Setup me account banayein.");
    }

    // Score every account by how many of the sheet's distinct SKUs are mapped
    // under it (plus its per-brand SKU codes — unmapped-but-known codes still
    // identify the brand). Shares overlap so ties stay deterministic.
    const skuSet = new Set(distinctSkus);
    const scored = [];
    for (const account of accounts) {
      const maps = await db
        .select({ marketplaceSku: marketplaceSkuMap.marketplaceSku })
        .from(marketplaceSkuMap)
        .where(eq(marketplaceSkuMap.marketplaceAccountId, account.id));
      const mapSet = new Set(maps.map((m) => m.marketplaceSku));
      const brandSkuCodes = new Set(
        (
          await db
            .select({ code: skus.code })
            .from(skus)
            .where(eq(skus.brandId, account.brandId))
        ).map((s) => s.code)
      );
      const hits = distinctSkus.filter((s) => mapSet.has(s)).length;
      const brandHits = distinctSkus.filter((s) => brandSkuCodes.has(s)).length;
      const best = Math.max(hits, brandHits);
      scored.push({
        accountId: account.id,
        marketplace: account.marketplace,
        sellerAccountLabel: account.sellerAccountLabel,
        brandId: account.brandId,
        brandName: account.brandName,
        hits: best,
        total: distinctSkus.length,
        confidence: distinctSkus.length > 0 ? best / distinctSkus.length : 0,
      });
    }
    scored.sort((a, b) => b.hits - a.hits || a.accountId - b.accountId);

    const top = scored[0];
    res.json({
      marketplace,
      totalSkus: distinctSkus.length,
      candidates: scored.filter((c) => c.hits > 0),
      detected: top && top.hits > 0 ? top : null,
    });
  } catch (err) {
    next(err);
  }
});

dashboardRouter.post("/google-sheet", requireSection("orders"), async (req, res, next) => {
  try {
    const body = sheetImportSchema.parse(req.body);
    const companyId = req.session!.companyId;

    // Ownership check — same scoping rule as the manual CSV import in orders.ts.
    const [account] = await db
      .select({ id: marketplaceAccounts.id, brandId: marketplaceAccounts.brandId })
      .from(marketplaceAccounts)
      .where(eq(marketplaceAccounts.id, body.marketplaceAccountId))
      .limit(1);
    if (!account) throw new HttpError(404, "Marketplace account not found");
    const [brand] = await db.select({ companyId: brands.companyId }).from(brands).where(eq(brands.id, account.brandId)).limit(1);
    if (!brand || brand.companyId !== companyId) {
      throw new HttpError(403, "Marketplace account does not belong to your company");
    }

    // Preferred path: the server fetches the CSV itself. Fallback: the panel
    // (public/app.js) also tries fetching it from the *user's browser* and
    // posts the CSV along as sheetCsv — the same parsers run either way, so
    // server networks with blocked egress to Google (dev sandboxes, strict
    // firewalls) still work end to end. Pasted CSV (no link at all) is the
    // last resort and skips URL parsing entirely.
    let csvText: string;
    let fetchedBy: "sheetCsv" | "serverFetch" = "serverFetch";

    if (body.sheetCsv && body.sheetCsv.trim().length > 0) {
      csvText = body.sheetCsv;
      fetchedBy = "sheetCsv";
    } else {
      const { spreadsheetId, gid } = parseSheetUrl(body.sheetUrl as string);
      // Google redirects to a googleusercontent URL carrying a short-lived
      // token in the path — follow the redirect server-side so the user just
      // pastes a normal link and the browser never has to touch Google.
      const exportUrl =
        `https://docs.google.com/spreadsheets/d/${spreadsheetId}/export?format=csv` +
        (gid ? `&gid=${gid}` : "");
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 25000);
      try {
        const resp = await fetch(exportUrl, {
          redirect: "follow",
          signal: controller.signal,
          headers: {
            "User-Agent": "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36",
          },
        });
        if (!resp.ok) {
          if (resp.status === 404 || resp.status === 401 || resp.status === 403) {
            throw new HttpError(400, "Sheet open nahi ho payi — 'Anyone with the link (Viewer)' sharing on karein, phir dobara try karein.");
          }
          throw new HttpError(502, `Google se CSV download fail hua (HTTP ${resp.status}).`);
        }
        const ct = resp.headers.get("content-type") || "";
        csvText = await resp.text();
        // Google answers *unauthenticated* visitors with an HTML login page
        // (200 + text/html) instead of the CSV — catch that here rather than
        // letting the CSV parser emit a confusing "format pehchana nahi" error.
        if (ct.includes("text/html") || csvText.trimStart().startsWith("<!DOCTYPE html")) {
          throw new HttpError(400, "Sheet public nahi hai — Share → 'Anyone with the link' (Viewer) on karein, phir import karein.");
        }
      } catch (err) {
        if (err instanceof HttpError) throw err;
        // Node's fetch aborts surface as DOMException (name: "AbortError"),
        // which is NOT an instanceof Error — match on the name, not the class.
        if (err && typeof err === "object" && (err as { name?: string }).name === "AbortError") {
          throw new HttpError(504, "Google se data laane me time out ho gaya — thodi der baad dobara try karein.");
        }
        throw new HttpError(502, "Google Sheet tak request pahunchi hi nahi — network/URL check karein.");
      } finally {
        clearTimeout(timeout);
      }
    }

    if (csvText.trim().length === 0) {
      throw new HttpError(400, "Sheet khali hai ya gid (tab) galat hai — jo tab import karna hai uske link me gid hona chahiye.");
    }

    const marketplace = detectMarketplace(csvText);
    const parser =
      marketplace === "flipkart" ? parseFlipkartExport : marketplace === "meesho" ? parseMeeshoExport : parseSnapdealExport;
    let normalizedOrders;
    try {
      normalizedOrders = parser(csvText);
    } catch (err) {
      // A sheet that LOOKS like an export but has mangled/unexpected values
      // (bad dates etc.) should surface as a fixable 400, not a 500.
      throw new HttpError(400, `Sheet parse nahi ho payi (${marketplace} format): ${err instanceof Error ? err.message : "unknown error"}`);
    }

    if (normalizedOrders.length === 0) {
      throw new HttpError(400, "Sheet me koi order row nahi mili — headers marketplace export jaise hain par rows khali hain.");
    }

    // Same per-order transaction + per-order error reporting as the manual
    // path (POST /orders/import/:marketplace in src/routes/orders.ts) --
    // kept in parity with it, including the duplicate-visibility,
    // stock-warning and SKU-auto-resolve reporting added there, since this
    // route calls the exact same ingestOrder() and gets the exact same
    // behavior from it.
    const results: {
      marketplaceOrderId: string;
      orderId?: number;
      created?: boolean;
      error?: string;
      stockWarning?: string;
      unmappedSku?: string;
      autoMappedSku?: string;
    }[] = [];
    for (const normalized of normalizedOrders) {
      try {
        const result = await ingestOrder(body.marketplaceAccountId, body.warehouseId, normalized, account.brandId);
        results.push({
          marketplaceOrderId: normalized.marketplaceOrderId,
          orderId: result.orderId,
          created: result.created,
          stockWarning: result.stockWarnings?.length
            ? `Imported, but no recorded stock for: ${result.stockWarnings.join(", ")} — do a Stock In when you can`
            : undefined,
          autoMappedSku: result.autoMappedSkus?.length
            ? result.autoMappedSkus
                .map((a) => `${a.marketplaceSku} → ${a.skuCode}${a.skuCreated ? " (new SKU created)" : " (matched existing SKU)"}`)
                .join("; ")
            : undefined,
        });
      } catch (err) {
        const message =
          err instanceof UnmappedSkuError || err instanceof InsufficientStockError ? err.message : "Ingestion failed for this order";
        results.push({
          marketplaceOrderId: normalized.marketplaceOrderId,
          error: message,
          unmappedSku: err instanceof UnmappedSkuError ? err.marketplaceSku : undefined,
        });
      }
    }

    const successRows = results.filter((r) => r.orderId);
    res.status(207).json({
      marketplace,
      imported: successRows.length,
      newOrders: successRows.filter((r) => r.created).length,
      duplicateOrders: successRows.filter((r) => !r.created).length,
      failed: results.filter((r) => r.error).length,
      stockWarnings: results.filter((r) => r.stockWarning).length,
      autoMapped: results.filter((r) => r.autoMappedSku).length,
      results,
      source: fetchedBy,
    });
  } catch (err) {
    next(err);
  }
});

/**
 * SKU list for the upload screen's "is my SKU mapped?" check.
 */
dashboardRouter.get("/brands/:brandId/skus", async (req, res, next) => {
  try {
    const brandId = Number(req.params.brandId);
    if (!Number.isInteger(brandId) || brandId <= 0) {
      return res.status(400).json({ error: "Invalid brandId" });
    }
    const [brand] = await db
      .select({ companyId: brands.companyId })
      .from(brands)
      .where(eq(brands.id, brandId))
      .limit(1);
    if (!brand || brand.companyId !== req.session!.companyId) {
      return res.status(403).json({ error: "Brand does not belong to your company" });
    }

    const rows = await db
      .select({ id: skus.id, code: skus.code, productTitle: skus.productTitle, size: skus.size })
      .from(skus)
      .where(eq(skus.brandId, brandId))
      .orderBy(skus.code)
      .limit(500);

    res.json(rows);
  } catch (err) {
    next(err);
  }
});
