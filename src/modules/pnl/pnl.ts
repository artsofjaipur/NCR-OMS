import { and, eq, gte, lte, lt, or, isNull, sql } from "drizzle-orm";
import { db } from "../../db/client";
import { orderItems, orders, costEntries, expenses, settlementLines, skus, brands } from "../../db/schema";

/**
 * P&L is never stored — it's computed on request from settled amounts,
 * period-dated unit cost, and period-dated overhead expenses, so a cost
 * correction retroactively corrects every past P&L read instead of leaving
 * stale numbers behind.
 */

async function unitCostAt(skuId: number, at: Date): Promise<number> {
  const [entry] = await db
    .select({ unitCost: costEntries.unitCost })
    .from(costEntries)
    .where(
      and(
        eq(costEntries.skuId, skuId),
        lte(costEntries.effectiveFrom, at),
        or(isNull(costEntries.effectiveTo), gte(costEntries.effectiveTo, at)),
      ),
    )
    .orderBy(sql`${costEntries.effectiveFrom} DESC`)
    .limit(1);
  return entry ? Number(entry.unitCost) : 0;
}

export interface OrderMargin {
  orderId: number;
  settledAmount: number;
  cogs: number;
  contributionMargin: number;
}

/** Contribution margin for one order: real settled amount minus COGS. */
export async function computeOrderMargin(orderId: number): Promise<OrderMargin> {
  const [order] = await db.select().from(orders).where(eq(orders.id, orderId)).limit(1);
  if (!order) throw new Error(`Order ${orderId} not found`);

  const items = await db.select().from(orderItems).where(eq(orderItems.orderId, orderId));

  const [settlement] = await db.select().from(settlementLines).where(eq(settlementLines.orderId, orderId)).limit(1);

  // Fall back to the invoiced amount if the order hasn't settled yet — the
  // read is then a projection, not a confirmed margin.
  const settledAmount = settlement?.paidAmount
    ? Number(settlement.paidAmount)
    : items.reduce((sum, i) => sum + Number(i.invoiceAmount ?? i.unitPrice) * i.quantity, 0);

  let cogs = 0;
  for (const item of items) {
    if (!item.skuId) continue;
    const unitCost = await unitCostAt(item.skuId, order.orderedAt);
    cogs += unitCost * item.quantity;
  }

  return {
    orderId,
    settledAmount,
    cogs,
    contributionMargin: Math.round((settledAmount - cogs) * 100) / 100,
  };
}

export interface BrandPnl {
  brandId: number;
  periodStart: Date;
  periodEnd: Date;
  contributionMargin: number;
  overheads: number;
  netPnl: number;
  orderCount: number;
}

/** Rolls order-level contribution margin up to a brand, net of that period's allocated overheads. */
export async function computeBrandPnl(brandId: number, periodStart: Date, periodEnd: Date): Promise<BrandPnl> {
  const rows = await db
    .select({ orderId: orders.id })
    .from(orders)
    .innerJoin(orderItems, eq(orderItems.orderId, orders.id))
    .innerJoin(skus, eq(skus.id, orderItems.skuId))
    .where(and(eq(skus.brandId, brandId), gte(orders.orderedAt, periodStart), lt(orders.orderedAt, periodEnd)));

  const uniqueOrderIds = [...new Set(rows.map((r) => r.orderId))];
  let contributionMargin = 0;
  for (const orderId of uniqueOrderIds) {
    const margin = await computeOrderMargin(orderId);
    contributionMargin += margin.contributionMargin;
  }

  const overheadRows = await db
    .select({ amount: expenses.amount })
    .from(expenses)
    .where(and(eq(expenses.brandId, brandId), gte(expenses.periodStart, periodStart), lte(expenses.periodEnd, periodEnd)));
  const overheads = overheadRows.reduce((sum, e) => sum + Number(e.amount), 0);

  return {
    brandId,
    periodStart,
    periodEnd,
    contributionMargin: Math.round(contributionMargin * 100) / 100,
    overheads,
    netPnl: Math.round((contributionMargin - overheads) * 100) / 100,
    orderCount: uniqueOrderIds.length,
  };
}

/** Same rollup, one level higher — every brand under a company. */
export async function computeCompanyPnl(companyId: number, periodStart: Date, periodEnd: Date) {
  const companyBrands = await db.select({ id: brands.id }).from(brands).where(eq(brands.companyId, companyId));
  const perBrand = await Promise.all(companyBrands.map((b) => computeBrandPnl(b.id, periodStart, periodEnd)));
  return {
    companyId,
    periodStart,
    periodEnd,
    contributionMargin: Math.round(perBrand.reduce((s, b) => s + b.contributionMargin, 0) * 100) / 100,
    overheads: Math.round(perBrand.reduce((s, b) => s + b.overheads, 0) * 100) / 100,
    netPnl: Math.round(perBrand.reduce((s, b) => s + b.netPnl, 0) * 100) / 100,
    perBrand,
  };
}
