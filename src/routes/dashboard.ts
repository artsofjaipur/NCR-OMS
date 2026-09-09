import { Router } from "express";
import { and, desc, eq, inArray, sql } from "drizzle-orm";
import { db } from "../db/client";
import { brands, orders, orderItems, warehouses, marketplaceAccounts, skus, returns } from "../db/schema";
import { requireAuth, requireCompanyScope } from "../middleware/auth";

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
