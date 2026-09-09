import { Router } from "express";
import { z } from "zod";
import { and, asc, desc, eq, gte, inArray, lte, sql } from "drizzle-orm";
import { db } from "../db/client";
import {
  brands,
  creditNotes,
  debitNotes,
  expenses,
  marketplaceAccounts,
  orderItems,
  orders,
  partyPayments,
  payoutBatches,
  purchaseEntries,
} from "../db/schema";
import { requireAuth, requireCompanyScope, requireRole } from "../middleware/auth";
import { requireSection } from "../security/permissions";
import { HttpError } from "../middleware/errorHandler";

export const reportsRouter = Router();
reportsRouter.use(requireAuth, requireCompanyScope, requireSection("reports"));

/* ---------------------------------------------------------------------------
 * EXPENSES — business overhead (rent, ads, packaging, salary…) with CRUD.
 * ------------------------------------------------------------------------- */

const expenseSchema = z.object({
  brandId: z.number().int().positive().nullable().optional(),
  category: z.string().trim().min(1).max(80),
  description: z.string().trim().max(300).optional(),
  amount: z.string().regex(/^\d+(\.\d{1,2})?$/),
  expenseDate: z.string().datetime(),
});

reportsRouter.get("/expenses", async (req, res, next) => {
  try {
    const rows = await db
      .select({
        id: expenses.id,
        brandId: expenses.brandId,
        brand: brands.name,
        category: expenses.category,
        notes: expenses.notes,
        amount: expenses.amount,
        periodStart: expenses.periodStart,
        createdAt: expenses.createdAt,
      })
      .from(expenses)
      .leftJoin(brands, eq(brands.id, expenses.brandId))
      .where(eq(sql`1`, sql`1`)) // placeholder replaced below by company filter via subquery
      .orderBy(desc(expenses.periodStart))
      .limit(300);
    // expenses is brand-scoped in schema — filter by the company's brands.
    const brandIds = new Set(
      (await db.select({ id: brands.id }).from(brands).where(eq(brands.companyId, req.session!.companyId))).map((b) => b.id)
    );
    res.json(rows.filter((r) => r.brandId !== null && brandIds.has(r.brandId)));
  } catch (err) {
    next(err);
  }
});

reportsRouter.post("/expenses", requireRole("OWNER", "ADMIN"), async (req, res, next) => {
  try {
    const body = expenseSchema.parse(req.body);
    if (body.brandId) {
      const [owned] = await db
        .select({ id: brands.id })
        .from(brands)
        .where(and(eq(brands.id, body.brandId), eq(brands.companyId, req.session!.companyId)))
        .limit(1);
      if (!owned) throw new HttpError(403, "Brand does not belong to your company");
    } else {
      // Unassigned expense: attach to the company's first brand so the
      // brand-scoped schema still holds it, but remember the intent.
      const [first] = await db.select({ id: brands.id }).from(brands).where(eq(brands.companyId, req.session!.companyId)).orderBy(brands.id).limit(1);
      if (!first) throw new HttpError(400, "Create a brand first");
      body.brandId = first.id;
    }
    const d = new Date(body.expenseDate);
    const [row] = await db
      .insert(expenses)
      .values({
        brandId: body.brandId!,
        category: body.category,
        notes: body.description ?? null,
        amount: body.amount,
        periodStart: d,
        periodEnd: new Date(d.getTime() + 24 * 60 * 60 * 1000 - 1),
      })
      .returning({ id: expenses.id });
    res.status(201).json({ id: row.id });
  } catch (err) {
    next(err);
  }
});

reportsRouter.patch("/expenses/:id", requireRole("OWNER", "ADMIN"), async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    const body = z
      .object({
        category: z.string().trim().min(1).max(80).optional(),
        description: z.string().trim().max(300).nullable().optional(),
        amount: z.string().regex(/^\d+(\.\d{1,2})?$/).optional(),
        expenseDate: z.string().datetime().optional(),
      })
      .parse(req.body);
    const [owned] = await db
      .select({ id: expenses.id, brandId: expenses.brandId })
      .from(expenses)
      .where(eq(expenses.id, id))
      .limit(1);
    if (!owned || !owned.brandId) throw new HttpError(404, "Expense not found");
    const [brand] = await db
      .select({ companyId: brands.companyId })
      .from(brands)
      .where(eq(brands.id, owned.brandId))
      .limit(1);
    if (!brand || brand.companyId !== req.session!.companyId) throw new HttpError(404, "Expense not found");

    const patch: Record<string, unknown> = {};
    if (body.category !== undefined) patch.category = body.category;
    if (body.description !== undefined) patch.notes = body.description;
    if (body.amount !== undefined) patch.amount = body.amount;
    if (body.expenseDate !== undefined) {
      const d = new Date(body.expenseDate);
      patch.periodStart = d;
      patch.periodEnd = new Date(d.getTime() + 24 * 60 * 60 * 1000 - 1);
    }
    await db.update(expenses).set(patch).where(eq(expenses.id, id));
    res.status(204).end();
  } catch (err) {
    next(err);
  }
});

reportsRouter.delete("/expenses/:id", requireRole("OWNER", "ADMIN"), async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    const [owned] = await db
      .select({ id: expenses.id, brandId: expenses.brandId })
      .from(expenses)
      .where(eq(expenses.id, id))
      .limit(1);
    if (!owned || !owned.brandId) throw new HttpError(404, "Expense not found");
    const [brand] = await db.select({ companyId: brands.companyId }).from(brands).where(eq(brands.id, owned.brandId)).limit(1);
    if (!brand || brand.companyId !== req.session!.companyId) throw new HttpError(404, "Expense not found");
    await db.delete(expenses).where(eq(expenses.id, id));
    res.status(204).end();
  } catch (err) {
    next(err);
  }
});

/* ---------------------------------------------------------------------------
 * STORE FEES — per seller account (commission / shipping / misc deductions).
 * These reconcile the gap between GMV and the payout actually received.
 * ------------------------------------------------------------------------- */

const feeSchema = z.object({
  marketplaceAccountId: z.number().int().positive(),
  feeType: z.enum(["COMMISSION", "SHIPPING", "PACKAGING", "PENALTY", "OTHER"]),
  amount: z.string().regex(/^\d+(\.\d{1,2})?$/),
  feeDate: z.string().datetime(),
  notes: z.string().trim().max(300).optional(),
});

reportsRouter.get("/store-fees", async (req, res, next) => {
  try {
    const rows = await db
      .select({
        id: payoutBatches.id,
        store: marketplaceAccounts.sellerAccountLabel,
        marketplace: marketplaceAccounts.marketplace,
        expectedDate: payoutBatches.expectedDate,
        expectedAmount: payoutBatches.expectedAmount,
        receivedAmount: payoutBatches.receivedAmount,
        receivedDate: payoutBatches.receivedDate,
        bankReference: payoutBatches.bankReference,
        status: payoutBatches.status,
      })
      .from(payoutBatches)
      .innerJoin(marketplaceAccounts, eq(marketplaceAccounts.id, payoutBatches.marketplaceAccountId))
      .innerJoin(brands, eq(brands.id, marketplaceAccounts.brandId))
      .where(eq(brands.companyId, req.session!.companyId))
      .orderBy(desc(payoutBatches.expectedDate))
      .limit(300);
    // Deduction view: expected vs received IS the fee for the batch.
    res.json(
      rows.map((r) => ({
        ...r,
        fee: (Number(r.expectedAmount) - Number(r.receivedAmount ?? r.expectedAmount)).toFixed(2),
      }))
    );
  } catch (err) {
    next(err);
  }
});

/* ---------------------------------------------------------------------------
 * TURNOVER — GMV and settled revenue per day / per brand / per store.
 * ------------------------------------------------------------------------- */

reportsRouter.get("/turnover", async (req, res, next) => {
  try {
    const start = req.query.start ? new Date(String(req.query.start)) : new Date(Date.now() - 89 * 24 * 3600 * 1000);
    const end = req.query.end ? new Date(String(req.query.end)) : new Date();

    const byDay = await db
      .select({
        day: sql<string>`to_char(date_trunc('day', ${orders.orderedAt}), 'YYYY-MM-DD')`,
        gmv: sql<string>`coalesce(sum(${orderItems.invoiceAmount}), 0)::text`,
        orderCount: sql<number>`count(distinct ${orders.id})::int`,
      })
      .from(orders)
      .innerJoin(marketplaceAccounts, eq(marketplaceAccounts.id, orders.marketplaceAccountId))
      .innerJoin(brands, eq(brands.id, marketplaceAccounts.brandId))
      .leftJoin(orderItems, eq(orderItems.orderId, orders.id))
      .where(and(eq(brands.companyId, req.session!.companyId), gte(orders.orderedAt, start), lte(orders.orderedAt, end)))
      .groupBy(sql`date_trunc('day', ${orders.orderedAt})`)
      .orderBy(asc(sql`date_trunc('day', ${orders.orderedAt})`));

    const byBrand = await db
      .select({
        brand: brands.name,
        gmv: sql<string>`coalesce(sum(${orderItems.invoiceAmount}), 0)::text`,
        orderCount: sql<number>`count(distinct ${orders.id})::int`,
      })
      .from(orders)
      .innerJoin(marketplaceAccounts, eq(marketplaceAccounts.id, orders.marketplaceAccountId))
      .innerJoin(brands, eq(brands.id, marketplaceAccounts.brandId))
      .leftJoin(orderItems, eq(orderItems.orderId, orders.id))
      .where(and(eq(brands.companyId, req.session!.companyId), gte(orders.orderedAt, start), lte(orders.orderedAt, end)))
      .groupBy(brands.name)
      .orderBy(desc(sql`coalesce(sum(${orderItems.invoiceAmount}), 0)`));

    const byStore = await db
      .select({
        store: marketplaceAccounts.sellerAccountLabel,
        marketplace: marketplaceAccounts.marketplace,
        brand: brands.name,
        gmv: sql<string>`coalesce(sum(${orderItems.invoiceAmount}), 0)::text`,
        orderCount: sql<number>`count(distinct ${orders.id})::int`,
      })
      .from(orders)
      .innerJoin(marketplaceAccounts, eq(marketplaceAccounts.id, orders.marketplaceAccountId))
      .innerJoin(brands, eq(brands.id, marketplaceAccounts.brandId))
      .leftJoin(orderItems, eq(orderItems.orderId, orders.id))
      .where(and(eq(brands.companyId, req.session!.companyId), gte(orders.orderedAt, start), lte(orders.orderedAt, end)))
      .groupBy(marketplaceAccounts.sellerAccountLabel, marketplaceAccounts.marketplace, brands.name)
      .orderBy(desc(sql`coalesce(sum(${orderItems.invoiceAmount}), 0)`));

    res.json({
      start: start.toISOString(),
      end: end.toISOString(),
      totalGmv: byDay.reduce((s, d) => s + Number(d.gmv), 0).toFixed(2),
      totalOrders: byDay.reduce((s, d) => s + d.orderCount, 0),
      byDay,
      byBrand,
      byStore,
    });
  } catch (err) {
    next(err);
  }
});

/* ---------------------------------------------------------------------------
 * PROFIT & LOSS — revenue, COGS-basis payouts gap, party bills, expenses.
 * Money view for the period, all feeds interconnected.
 * ------------------------------------------------------------------------- */

reportsRouter.get("/pnl", async (req, res, next) => {
  try {
    const companyId = req.session!.companyId;
    const start = req.query.start ? new Date(String(req.query.start)) : new Date(new Date().getFullYear(), new Date().getMonth(), 1);
    const end = req.query.end ? new Date(String(req.query.end)) : new Date();

    const accountIds = (
      await db
        .select({ id: marketplaceAccounts.id })
        .from(marketplaceAccounts)
        .innerJoin(brands, eq(brands.id, marketplaceAccounts.brandId))
        .where(eq(brands.companyId, companyId))
    ).map((a) => a.id);

    const inScope = accountIds.length > 0 ? inArray(orders.marketplaceAccountId, accountIds) : sql`false`;
    const periodScope = and(gte(orders.orderedAt, start), lte(orders.orderedAt, end));

    const [rev] = await db
      .select({ gmv: sql<string>`coalesce(sum(${orderItems.invoiceAmount}), 0)::text` })
      .from(orders)
      .leftJoin(orderItems, eq(orderItems.orderId, orders.id))
      .where(and(inScope, periodScope));

    const [payout] = await db
      .select({
        received: sql<string>`coalesce(sum(${payoutBatches.receivedAmount}), 0)::text`,
        expected: sql<string>`coalesce(sum(${payoutBatches.expectedAmount}), 0)::text`,
      })
      .from(payoutBatches)
      .where(accountIds.length > 0 ? and(inArray(payoutBatches.marketplaceAccountId, accountIds), gte(payoutBatches.expectedDate, start), lte(payoutBatches.expectedDate, end)) : sql`false`);

    const [bills] = await db
      .select({ total: sql<string>`coalesce(sum(${purchaseEntries.totalAmount}), 0)::text` })
      .from(purchaseEntries)
      .where(and(eq(purchaseEntries.companyId, companyId), gte(purchaseEntries.createdAt, start), lte(purchaseEntries.createdAt, end)));

    const [paid] = await db
      .select({ total: sql<string>`coalesce(sum(${partyPayments.amount}), 0)::text` })
      .from(partyPayments)
      .where(and(eq(partyPayments.companyId, companyId), gte(partyPayments.paidAt, start), lte(partyPayments.paidAt, end)));

    const brandIds = (await db.select({ id: brands.id }).from(brands).where(eq(brands.companyId, companyId))).map((b) => b.id);
    const [exp] = await db
      .select({ total: sql<string>`coalesce(sum(${expenses.amount}), 0)::text` })
      .from(expenses)
      .where(brandIds.length > 0 ? and(inArray(expenses.brandId, brandIds), gte(expenses.periodStart, start), lte(expenses.periodStart, end)) : sql`false`);

    const gmv = Number(rev?.gmv ?? 0);
    const received = Number(payout?.received ?? 0);
    const purchases = Number(bills?.total ?? 0);
    const expensesTotal = Number(exp?.total ?? 0);
    const storeFees = Number(payout?.expected ?? 0) - received;

    res.json({
      period: { start: start.toISOString(), end: end.toISOString() },
      gmv,
      payoutReceived: received,
      storeFees: Math.max(0, storeFees).toFixed(2),
      purchases,
      paymentsToParties: Number(paid?.total ?? 0),
      expenses: expensesTotal,
      grossProfit: (received - purchases).toFixed(2),
      netProfit: (received - purchases - expensesTotal).toFixed(2),
    });
  } catch (err) {
    next(err);
  }
});

/* ---------------------------------------------------------------------------
 * BALANCE SHEET — what the world owes us vs what we owe, right now.
 * ------------------------------------------------------------------------- */

reportsRouter.get("/balance", async (req, res, next) => {
  try {
    const companyId = req.session!.companyId;

    const accountIds = (
      await db
        .select({ id: marketplaceAccounts.id })
        .from(marketplaceAccounts)
        .innerJoin(brands, eq(brands.id, marketplaceAccounts.brandId))
        .where(eq(brands.companyId, companyId))
    ).map((a) => a.id);

    const [pendingPayouts] = await db
      .select({
        pending: sql<string>`coalesce(sum(${payoutBatches.expectedAmount} - coalesce(${payoutBatches.receivedAmount}, 0)), 0)::text`,
      })
      .from(payoutBatches)
      .where(accountIds.length > 0 ? and(inArray(payoutBatches.marketplaceAccountId, accountIds), sql`${payoutBatches.receivedDate} is null`) : sql`false`);

    const [bills] = await db
      .select({ total: sql<string>`coalesce(sum(${purchaseEntries.totalAmount}), 0)::text` })
      .from(purchaseEntries)
      .where(eq(purchaseEntries.companyId, companyId));

    const [paid] = await db
      .select({ total: sql<string>`coalesce(sum(${partyPayments.amount}), 0)::text` })
      .from(partyPayments)
      .where(eq(partyPayments.companyId, companyId));

    const [credit] = await db
      .select({ total: sql<string>`coalesce(sum(${creditNotes.amount}), 0)::text` })
      .from(creditNotes)
      .where(eq(creditNotes.companyId, companyId));

    const [debit] = await db
      .select({ total: sql<string>`coalesce(sum(${debitNotes.amount}), 0)::text` })
      .from(debitNotes)
      .where(eq(debitNotes.companyId, companyId));

    const receivable = Number(pendingPayouts?.pending ?? 0);
    const payable = Math.max(0, Number(bills?.total ?? 0) - Number(paid?.total ?? 0) - Number(credit?.total ?? 0) + Number(debit?.total ?? 0));

    res.json({
      receivable: receivable.toFixed(2),
      payable: payable.toFixed(2),
      netPosition: (receivable - payable).toFixed(2),
      components: {
        pendingPayouts: receivable.toFixed(2),
        billsTotal: bills?.total ?? "0",
        paymentsMade: paid?.total ?? "0",
        creditNotes: credit?.total ?? "0",
        debitNotes: debit?.total ?? "0",
      },
    });
  } catch (err) {
    next(err);
  }
});
