import { Router } from "express";
import { z } from "zod";
import { and, asc, desc, eq, gte, isNotNull, sql } from "drizzle-orm";
import { db } from "../db/client";
import {
  brands,
  marketplaceAccounts,
  partyPayments,
  payoutBatches,
  purchaseEntries,
  creditNotes,
  debitNotes,
  suppliers,
  users,
} from "../db/schema";
import { requireSection } from "../security/permissions";
import { requireAuth, requireCompanyScope, requireRole } from "../middleware/auth";
import { HttpError } from "../middleware/errorHandler";

export const financeRouter = Router();
financeRouter.use(requireAuth, requireCompanyScope, requireSection("finance"));

/** Drizzle wraps pg errors in DrizzleQueryError — the pg code lives on `cause`. */
function isUniqueViolation(e: unknown): boolean {
  const err = e as { code?: string; cause?: { code?: string } };
  return err?.code === "23505" || err?.cause?.code === "23505";
}

const COMPANY = (req: { session?: { companyId: number } | null }) => req.session!.companyId;

/* ---------------------------------------------------------------------------
 * OVERVIEW — money in (per store) vs money out (per party) + KPIs
 * ------------------------------------------------------------------------- */

financeRouter.get("/overview", async (req, res, next) => {
  try {
    const companyId = COMPANY(req);

    const [payoutRow] = await db
      .select({
        received: sql<string>`coalesce(sum(${payoutBatches.receivedAmount}), 0)::text`,
        expected: sql<string>`coalesce(sum(${payoutBatches.expectedAmount}), 0)::text`,
        pendingCount: sql<number>`count(*) filter (where ${payoutBatches.receivedDate} is null)::int`,
      })
      .from(payoutBatches)
      .innerJoin(marketplaceAccounts, eq(marketplaceAccounts.id, payoutBatches.marketplaceAccountId))
      .innerJoin(brands, eq(brands.id, marketplaceAccounts.brandId))
      .where(eq(brands.companyId, companyId));

    const [billsRow] = await db
      .select({
        total: sql<string>`coalesce(sum(${purchaseEntries.totalAmount}), 0)::text`,
        billCount: sql<number>`count(*)::int`,
        overdueCount: sql<number>`count(*) filter (where ${purchaseEntries.dueDate} is not null and ${purchaseEntries.dueDate} < now())::int`,
      })
      .from(purchaseEntries)
      .where(and(eq(purchaseEntries.companyId, companyId), isNotNull(purchaseEntries.totalAmount)));

    const [paidRow] = await db
      .select({ paid: sql<string>`coalesce(sum(${partyPayments.amount}), 0)::text` })
      .from(partyPayments)
      .where(eq(partyPayments.companyId, companyId));

    const [creditRow] = await db
      .select({ total: sql<string>`coalesce(sum(${creditNotes.amount}), 0)::text` })
      .from(creditNotes)
      .where(eq(creditNotes.companyId, companyId));

    const [debitRow] = await db
      .select({ total: sql<string>`coalesce(sum(${debitNotes.amount}), 0)::text` })
      .from(debitNotes)
      .where(eq(debitNotes.companyId, companyId));

    // Kis store se kitna aaya — payout receive split per seller account.
    const byStore = await db
      .select({
        accountId: marketplaceAccounts.id,
        store: marketplaceAccounts.sellerAccountLabel,
        marketplace: marketplaceAccounts.marketplace,
        brand: brands.name,
        received: sql<string>`coalesce(sum(${payoutBatches.receivedAmount}), 0)::text`,
        pending: sql<string>`coalesce(sum(case when ${payoutBatches.receivedDate} is null then ${payoutBatches.expectedAmount} - coalesce(${payoutBatches.receivedAmount}, 0) else 0 end), 0)::text`,
      })
      .from(payoutBatches)
      .innerJoin(marketplaceAccounts, eq(marketplaceAccounts.id, payoutBatches.marketplaceAccountId))
      .innerJoin(brands, eq(brands.id, marketplaceAccounts.brandId))
      .where(eq(brands.companyId, companyId))
      .groupBy(marketplaceAccounts.id, marketplaceAccounts.sellerAccountLabel, marketplaceAccounts.marketplace, brands.name)
      .orderBy(desc(sql`coalesce(sum(${payoutBatches.receivedAmount}), 0)`));

    res.json({
      moneyIn: {
        received: payoutRow?.received ?? "0",
        expected: payoutRow?.expected ?? "0",
        pendingCount: payoutRow?.pendingCount ?? 0,
      },
      moneyOut: {
        billsTotal: billsRow?.total ?? "0",
        billCount: billsRow?.billCount ?? 0,
        paid: paidRow?.paid ?? "0",
        creditNotes: creditRow?.total ?? "0",
        debitNotes: debitRow?.total ?? "0",
        // Outstanding = bills not covered by payments or supplier credit notes
        // (net credit reduces what we owe — same convention as Zoho Books).
        outstanding: Math.max(
          0,
          Number(billsRow?.total ?? 0) - Number(paidRow?.paid ?? 0) - Number(creditRow?.total ?? 0)
        ).toFixed(2),
        overdueCount: billsRow?.overdueCount ?? 0,
      },
      byStore,
    });
  } catch (err) {
    next(err);
  }
});

/* ---------------------------------------------------------------------------
 * MONEY IN — store-wise payout batches (kis store se, kab, kitna)
 * ------------------------------------------------------------------------- */

financeRouter.get("/payouts", async (req, res, next) => {
  try {
    const rows = await db
      .select({
        id: payoutBatches.id,
        store: marketplaceAccounts.sellerAccountLabel,
        marketplace: marketplaceAccounts.marketplace,
        brand: brands.name,
        expectedDate: payoutBatches.expectedDate,
        expectedAmount: payoutBatches.expectedAmount,
        receivedDate: payoutBatches.receivedDate,
        receivedAmount: payoutBatches.receivedAmount,
        bankReference: payoutBatches.bankReference,
        status: payoutBatches.status,
      })
      .from(payoutBatches)
      .innerJoin(marketplaceAccounts, eq(marketplaceAccounts.id, payoutBatches.marketplaceAccountId))
      .innerJoin(brands, eq(brands.id, marketplaceAccounts.brandId))
      .where(eq(brands.companyId, req.session!.companyId))
      .orderBy(desc(payoutBatches.expectedDate))
      .limit(200);
    res.json(rows);
  } catch (err) {
    next(err);
  }
});

/* ---------------------------------------------------------------------------
 * BILLS — supplier bills (purchase entries) with running balance
 * ------------------------------------------------------------------------- */

financeRouter.get("/bills", async (req, res, next) => {
  try {
    const companyId = req.session!.companyId;

    const rows = await db
      .select({
        id: purchaseEntries.id,
        supplierId: purchaseEntries.supplierId,
        supplier: suppliers.name,
        invoiceNumber: purchaseEntries.supplierInvoiceNumber,
        invoiceDate: purchaseEntries.invoiceDate,
        dueDate: purchaseEntries.dueDate,
        notes: purchaseEntries.notes,
        total: purchaseEntries.totalAmount,
        createdAt: purchaseEntries.createdAt,
      })
      .from(purchaseEntries)
      .leftJoin(suppliers, eq(suppliers.id, purchaseEntries.supplierId))
      .where(eq(purchaseEntries.companyId, companyId))
      .orderBy(desc(purchaseEntries.createdAt))
      .limit(200);

    const paidMap = await db
      .select({ billId: partyPayments.purchaseEntryId, paid: sql<string>`coalesce(sum(${partyPayments.amount}), 0)::text` })
      .from(partyPayments)
      .where(and(eq(partyPayments.companyId, companyId), isNotNull(partyPayments.purchaseEntryId)))
      .groupBy(partyPayments.purchaseEntryId);
    const paidFor = new Map(paidMap.map((r) => [r.billId, Number(r.paid)]));

    const creditMap = await db
      .select({ billId: creditNotes.purchaseEntryId, credit: sql<string>`coalesce(sum(${creditNotes.amount}), 0)::text` })
      .from(creditNotes)
      .where(and(eq(creditNotes.companyId, companyId), isNotNull(creditNotes.purchaseEntryId)))
      .groupBy(creditNotes.purchaseEntryId);
    const creditFor = new Map(creditMap.map((r) => [r.billId, Number(r.credit)]));

    const bills = rows.map((r) => {
      const total = Number(r.total ?? 0);
      const paid = paidFor.get(r.id) ?? 0;
      const credited = creditFor.get(r.id) ?? 0;
      const balance = Math.max(0, total - paid - credited);
      const overdue = !!r.dueDate && r.dueDate.getTime() < Date.now() && balance > 0;
      return {
        ...r,
        paid: paid.toFixed(2),
        credited: credited.toFixed(2),
        balance: balance.toFixed(2),
        overdue,
        settled: balance <= 0.009,
      };
    });
    res.json(bills);
  } catch (err) {
    next(err);
  }
});

/* ---------------------------------------------------------------------------
 * PAYMENTS — money paid to parties (against a bill or on account)
 * ------------------------------------------------------------------------- */

const paymentSchema = z.object({
  supplierId: z.number().int().positive(),
  purchaseEntryId: z.number().int().positive().optional(),
  bankAccountId: z.number().int().positive().optional(),
  amount: z.string().regex(/^\d+(\.\d{1,2})?$/, "Amount must be like 1234.50"),
  method: z.enum(["BANK_TRANSFER", "CASH", "UPI", "CHEQUE", "ADJUSTED"]).default("BANK_TRANSFER"),
  reference: z.string().max(100).optional(),
  paidAt: z.string().datetime().optional(),
  notes: z.string().optional(),
});

financeRouter.get("/payments", async (req, res, next) => {
  try {
    const supplierId = req.query.supplierId ? Number(req.query.supplierId) : null;
    const rows = await db
      .select({
        id: partyPayments.id,
        supplier: suppliers.name,
        purchaseEntryId: partyPayments.purchaseEntryId,
        amount: partyPayments.amount,
        method: partyPayments.method,
        reference: partyPayments.reference,
        paidAt: partyPayments.paidAt,
        notes: partyPayments.notes,
        by: users.displayName,
      })
      .from(partyPayments)
      .leftJoin(suppliers, eq(suppliers.id, partyPayments.supplierId))
      .leftJoin(users, eq(users.id, partyPayments.createdByUserId))
      .where(
        supplierId
          ? and(eq(partyPayments.companyId, req.session!.companyId), eq(partyPayments.supplierId, supplierId))
          : eq(partyPayments.companyId, req.session!.companyId)
      )
      .orderBy(desc(partyPayments.paidAt))
      .limit(200);
    res.json(rows);
  } catch (err) {
    next(err);
  }
});

financeRouter.post("/payments", requireRole("OWNER", "ADMIN"), async (req, res, next) => {
  try {
    const body = paymentSchema.parse(req.body);
    const [party] = await db
      .select({ id: suppliers.id })
      .from(suppliers)
      .where(and(eq(suppliers.id, body.supplierId), eq(suppliers.companyId, req.session!.companyId)))
      .limit(1);
    if (!party) throw new HttpError(404, "Supplier not found in your workspace");

    if (body.purchaseEntryId) {
      const [bill] = await db
        .select({ id: purchaseEntries.id })
        .from(purchaseEntries)
        .where(and(eq(purchaseEntries.id, body.purchaseEntryId), eq(purchaseEntries.companyId, req.session!.companyId)))
        .limit(1);
      if (!bill) throw new HttpError(404, "Bill not found in your workspace");
    }

    const [row] = await db
      .insert(partyPayments)
      .values({
        companyId: req.session!.companyId,
        supplierId: body.supplierId,
        purchaseEntryId: body.purchaseEntryId ?? null,
        bankAccountId: body.bankAccountId ?? null,
        amount: body.amount,
        method: body.method,
        reference: body.reference ?? null,
        paidAt: body.paidAt ? new Date(body.paidAt) : new Date(),
        notes: body.notes ?? null,
        createdByUserId: req.session!.userId,
      })
      .returning({ id: partyPayments.id });
    res.status(201).json({ id: row.id });
  } catch (err) {
    next(err);
  }
});

/** Delete a payment (typo fix) — balances recompute from what remains. */
financeRouter.delete("/payments/:id", requireRole("OWNER", "ADMIN"), async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) throw new HttpError(400, "Invalid payment id");
    const [owned] = await db
      .select({ id: partyPayments.id })
      .from(partyPayments)
      .where(and(eq(partyPayments.id, id), eq(partyPayments.companyId, req.session!.companyId)))
      .limit(1);
    if (!owned) throw new HttpError(404, "Payment not found");
    await db.delete(partyPayments).where(eq(partyPayments.id, id));
    res.status(204).end();
  } catch (err) {
    next(err);
  }
});

/** Edit a bill's due date / notes / invoice number (total stays item-derived). */
financeRouter.patch("/bills/:id", requireRole("OWNER", "ADMIN"), async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) throw new HttpError(400, "Invalid bill id");
    const body = z
      .object({
        dueDate: z.string().datetime().nullable().optional(),
        notes: z.string().max(500).nullable().optional(),
        supplierInvoiceNumber: z.string().trim().max(100).nullable().optional(),
      })
      .parse(req.body);
    const [owned] = await db
      .select({ id: purchaseEntries.id })
      .from(purchaseEntries)
      .where(and(eq(purchaseEntries.id, id), eq(purchaseEntries.companyId, req.session!.companyId)))
      .limit(1);
    if (!owned) throw new HttpError(404, "Bill not found");
    const patch: Record<string, unknown> = {};
    if (body.dueDate !== undefined) patch.dueDate = body.dueDate ? new Date(body.dueDate) : null;
    if (body.notes !== undefined) patch.notes = body.notes;
    if (body.supplierInvoiceNumber !== undefined) patch.supplierInvoiceNumber = body.supplierInvoiceNumber;
    if (Object.keys(patch).length === 0) return res.status(204).end();
    await db.update(purchaseEntries).set(patch).where(eq(purchaseEntries.id, id));
    res.status(204).end();
  } catch (err) {
    next(err);
  }
});

/* ---------------------------------------------------------------------------
 * CREDIT / DEBIT NOTES — adjustments against parties
 * ------------------------------------------------------------------------- */

const noteSchema = z.object({
  supplierId: z.number().int().positive(),
  purchaseEntryId: z.number().int().positive().optional(),
  noteNumber: z.string().min(1).max(100),
  amount: z.string().regex(/^\d+(\.\d{1,2})?$/, "Amount must be like 1234.50"),
  reason: z.string().optional(),
  noteDate: z.string().datetime().optional(),
});

financeRouter.get("/notes", async (req, res, next) => {
  try {
    const type = req.query.type === "debit" ? "debit" : "credit";
    const table = type === "debit" ? debitNotes : creditNotes;
    const rows = await db
      .select({
        id: table.id,
        noteNumber: table.noteNumber,
        supplier: suppliers.name,
        purchaseEntryId: table.purchaseEntryId,
        amount: table.amount,
        reason: table.reason,
        noteDate: table.noteDate,
      })
      .from(table)
      .leftJoin(suppliers, eq(suppliers.id, table.supplierId))
      .where(eq(table.companyId, req.session!.companyId))
      .orderBy(desc(table.noteDate))
      .limit(200);
    res.json(rows);
  } catch (err) {
    next(err);
  }
});

financeRouter.post("/notes/credit", requireRole("OWNER", "ADMIN"), async (req, res, next) => {
  try {
    const body = noteSchema.parse(req.body);
    const [party] = await db
      .select({ id: suppliers.id })
      .from(suppliers)
      .where(and(eq(suppliers.id, body.supplierId), eq(suppliers.companyId, req.session!.companyId)))
      .limit(1);
    if (!party) throw new HttpError(404, "Supplier not found in your workspace");
    try {
      const [row] = await db
        .insert(creditNotes)
        .values({
          companyId: req.session!.companyId,
          supplierId: body.supplierId,
          purchaseEntryId: body.purchaseEntryId ?? null,
          noteNumber: body.noteNumber,
          amount: body.amount,
          reason: body.reason ?? null,
          noteDate: body.noteDate ? new Date(body.noteDate) : new Date(),
        })
        .returning({ id: creditNotes.id });
      res.status(201).json({ id: row.id });
    } catch (e: unknown) {
      if (isUniqueViolation(e)) {
        throw new HttpError(409, "A credit note with this number already exists");
      }
      throw e;
    }
  } catch (err) {
    next(err);
  }
});

/** Delete a credit or debit note (typo fix) — party balance recomputes. */
financeRouter.delete("/notes/:type/:id", requireRole("OWNER", "ADMIN"), async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    const type = req.params.type === "debit" ? "debit" : "credit";
    if (!Number.isInteger(id) || id <= 0) throw new HttpError(400, "Invalid note id");
    const table = type === "debit" ? debitNotes : creditNotes;
    const [owned] = await db
      .select({ id: table.id })
      .from(table)
      .where(and(eq(table.companyId, req.session!.companyId), eq(table.id, id)))
      .limit(1);
    if (!owned) throw new HttpError(404, "Note not found");
    await db.delete(table).where(eq(table.id, id));
    res.status(204).end();
  } catch (err) {
    next(err);
  }
});

financeRouter.post("/notes/debit", requireRole("OWNER", "ADMIN"), async (req, res, next) => {
  try {
    const body = noteSchema.parse(req.body);
    const [party] = await db
      .select({ id: suppliers.id })
      .from(suppliers)
      .where(and(eq(suppliers.id, body.supplierId), eq(suppliers.companyId, req.session!.companyId)))
      .limit(1);
    if (!party) throw new HttpError(404, "Supplier not found in your workspace");
    try {
      const [row] = await db
        .insert(debitNotes)
        .values({
          companyId: req.session!.companyId,
          supplierId: body.supplierId,
          purchaseEntryId: body.purchaseEntryId ?? null,
          noteNumber: body.noteNumber,
          amount: body.amount,
          reason: body.reason ?? null,
          noteDate: body.noteDate ? new Date(body.noteDate) : new Date(),
        })
        .returning({ id: debitNotes.id });
      res.status(201).json({ id: row.id });
    } catch (e: unknown) {
      if (isUniqueViolation(e)) {
        throw new HttpError(409, "A debit note with this number already exists");
      }
      throw e;
    }
  } catch (err) {
    next(err);
  }
});

/* ---------------------------------------------------------------------------
 * PARTIES — supplier balances (bills − payments − credit + debit claims)
 * ------------------------------------------------------------------------- */

financeRouter.get("/parties", async (req, res, next) => {
  try {
    const companyId = req.session!.companyId;
    const rows = await db
      .select({
        id: suppliers.id,
        name: suppliers.name,
        gstin: suppliers.gstin,
        phone: suppliers.contactPhone,
        city: suppliers.city,
      })
      .from(suppliers)
      .where(eq(suppliers.companyId, companyId))
      .orderBy(asc(suppliers.name));

    const billedMap = await db
      .select({ supplierId: purchaseEntries.supplierId, total: sql<string>`coalesce(sum(${purchaseEntries.totalAmount}), 0)::text` })
      .from(purchaseEntries)
      .where(and(eq(purchaseEntries.companyId, companyId), isNotNull(purchaseEntries.totalAmount)))
      .groupBy(purchaseEntries.supplierId);
    const billed = new Map(billedMap.map((r) => [r.supplierId, Number(r.total)]));

    const paidMap = await db
      .select({ supplierId: partyPayments.supplierId, paid: sql<string>`coalesce(sum(${partyPayments.amount}), 0)::text` })
      .from(partyPayments)
      .where(eq(partyPayments.companyId, companyId))
      .groupBy(partyPayments.supplierId);
    const paid = new Map(paidMap.map((r) => [r.supplierId, Number(r.paid)]));

    const creditMap = await db
      .select({ supplierId: creditNotes.supplierId, credit: sql<string>`coalesce(sum(${creditNotes.amount}), 0)::text` })
      .from(creditNotes)
      .where(eq(creditNotes.companyId, companyId))
      .groupBy(creditNotes.supplierId);
    const credit = new Map(creditMap.map((r) => [r.supplierId, Number(r.credit)]));

    const debitMap = await db
      .select({ supplierId: debitNotes.supplierId, debit: sql<string>`coalesce(sum(${debitNotes.amount}), 0)::text` })
      .from(debitNotes)
      .where(eq(debitNotes.companyId, companyId))
      .groupBy(debitNotes.supplierId);
    const debit = new Map(debitMap.map((r) => [r.supplierId, Number(r.debit)]));

    const parties = rows.map((p) => {
      const billedAmt = billed.get(p.id) ?? 0;
      const paidAmt = paid.get(p.id) ?? 0;
      const creditAmt = credit.get(p.id) ?? 0;
      const debitAmt = debit.get(p.id) ?? 0;
      const balance = billedAmt - paidAmt - creditAmt + debitAmt;
      return { ...p, billed: billedAmt.toFixed(2), paid: paidAmt.toFixed(2), credit: creditAmt.toFixed(2), debit: debitAmt.toFixed(2), balance: balance.toFixed(2) };
    });
    res.json(parties);
  } catch (err) {
    next(err);
  }
});

/* ---------------------------------------------------------------------------
 * PARTY LEDGER — every money event for one party, date-referenced
 * ------------------------------------------------------------------------- */

financeRouter.get("/ledger", async (req, res, next) => {
  try {
    const companyId = req.session!.companyId;
    const supplierId = Number(req.query.supplierId);
    if (!Number.isInteger(supplierId) || supplierId <= 0) throw new HttpError(400, "supplierId is required");

    type Event = { date: Date | null; type: string; ref: string; detail: string; debit: string; credit: string };
    const events: Event[] = [];

    const bills = await db
      .select({ id: purchaseEntries.id, date: purchaseEntries.invoiceDate, createdAt: purchaseEntries.createdAt, total: purchaseEntries.totalAmount, invoice: purchaseEntries.supplierInvoiceNumber })
      .from(purchaseEntries)
      .where(and(eq(purchaseEntries.companyId, companyId), eq(purchaseEntries.supplierId, supplierId), isNotNull(purchaseEntries.totalAmount)))
      .orderBy(asc(purchaseEntries.createdAt));
    for (const b of bills) {
      events.push({
        date: b.date ?? b.createdAt,
        type: "BILL",
        ref: b.invoice ?? `Bill #${b.id}`,
        detail: "Purchase bill",
        debit: Number(b.total ?? 0).toFixed(2),
        credit: "0.00",
      });
    }

    const pays = await db
      .select({ id: partyPayments.id, date: partyPayments.paidAt, amount: partyPayments.amount, method: partyPayments.method, reference: partyPayments.reference, billId: partyPayments.purchaseEntryId })
      .from(partyPayments)
      .where(and(eq(partyPayments.companyId, companyId), eq(partyPayments.supplierId, supplierId)))
      .orderBy(asc(partyPayments.paidAt));
    for (const p of pays) {
      events.push({
        date: p.date,
        type: "PAYMENT",
        ref: p.reference ?? `Payment #${p.id}`,
        detail: `${p.method}${p.billId ? " · against bill #" + p.billId : ""}`,
        debit: "0.00",
        credit: Number(p.amount).toFixed(2),
      });
    }

    const cns = await db
      .select({ id: creditNotes.id, date: creditNotes.noteDate, number: creditNotes.noteNumber, amount: creditNotes.amount, reason: creditNotes.reason })
      .from(creditNotes)
      .where(and(eq(creditNotes.companyId, companyId), eq(creditNotes.supplierId, supplierId)))
      .orderBy(asc(creditNotes.noteDate));
    for (const n of cns) {
      events.push({ date: n.date, type: "CREDIT_NOTE", ref: n.number, detail: n.reason ?? "Supplier credit note", debit: "0.00", credit: Number(n.amount).toFixed(2) });
    }

    const dns = await db
      .select({ id: debitNotes.id, date: debitNotes.noteDate, number: debitNotes.noteNumber, amount: debitNotes.amount, reason: debitNotes.reason })
      .from(debitNotes)
      .where(and(eq(debitNotes.companyId, companyId), eq(debitNotes.supplierId, supplierId)))
      .orderBy(asc(debitNotes.noteDate));
    for (const n of dns) {
      events.push({ date: n.date, type: "DEBIT_NOTE", ref: n.number, detail: n.reason ?? "Debit note claim", debit: Number(n.amount).toFixed(2), credit: "0.00" });
    }

    events.sort((a, b) => (a.date?.getTime() ?? 0) - (b.date?.getTime() ?? 0));

    // Running balance (debit − credit accumulates).
    let running = 0;
    const ledger = events.map((e) => {
      running += Number(e.debit) - Number(e.credit);
      return { ...e, balance: running.toFixed(2) };
    });
    res.json({ supplierId, closing: running.toFixed(2), entries: ledger.reverse() });
  } catch (err) {
    next(err);
  }
});

/* ---------------------------------------------------------------------------
 * CASHFLOW — last 30 days: money in (payouts received) vs money out (payments)
 * ------------------------------------------------------------------------- */

financeRouter.get("/cashflow", async (req, res, next) => {
  try {
    const companyId = req.session!.companyId;
    const since = new Date(Date.now() - 29 * 24 * 60 * 60 * 1000);

    const inflow = await db
      .select({
        day: sql<string>`to_char(date_trunc('day', ${payoutBatches.receivedDate}), 'YYYY-MM-DD')`,
        amount: sql<string>`coalesce(sum(${payoutBatches.receivedAmount}), 0)::text`,
      })
      .from(payoutBatches)
      .innerJoin(marketplaceAccounts, eq(marketplaceAccounts.id, payoutBatches.marketplaceAccountId))
      .innerJoin(brands, eq(brands.id, marketplaceAccounts.brandId))
      .where(and(eq(brands.companyId, companyId), isNotNull(payoutBatches.receivedDate), gte(payoutBatches.receivedDate, since)))
      .groupBy(sql`date_trunc('day', ${payoutBatches.receivedDate})`);

    const outflow = await db
      .select({
        day: sql<string>`to_char(date_trunc('day', ${partyPayments.paidAt}), 'YYYY-MM-DD')`,
        amount: sql<string>`coalesce(sum(${partyPayments.amount}), 0)::text`,
      })
      .from(partyPayments)
      .where(and(eq(partyPayments.companyId, companyId), gte(partyPayments.paidAt, since)))
      .groupBy(sql`date_trunc('day', ${partyPayments.paidAt})`);

    const byDay = new Map<string, { in: number; out: number }>();
    for (let i = 29; i >= 0; i--) {
      const d = new Date(Date.now() - i * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
      byDay.set(d, { in: 0, out: 0 });
    }
    for (const r of inflow) {
      const cell = byDay.get(r.day);
      if (cell) cell.in = Number(r.amount);
    }
    for (const r of outflow) {
      const cell = byDay.get(r.day);
      if (cell) cell.out = Number(r.amount);
    }
    const series = Array.from(byDay.entries()).map(([day, v]) => ({ day, in: v.in.toFixed(2), out: v.out.toFixed(2), net: (v.in - v.out).toFixed(2) }));
    res.json(series);
  } catch (err) {
    next(err);
  }
});
