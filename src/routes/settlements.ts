import { Router } from "express";
import { z } from "zod";
import { and, desc, eq, gte, lte, sql } from "drizzle-orm";
import { db } from "../db/client";
import { settlementImports, settlementEntries, marketplaceAccounts, brands, orders } from "../db/schema";
import { requireAuth, requireCompanyScope, requireRole } from "../middleware/auth";
import { requireSection } from "../security/permissions";
import { HttpError } from "../middleware/errorHandler";
import { parseSettlementFile } from "../ingestion/parsers/settlements";
import { importSettlementWorkbook, getSettlementEntriesForOrder, marketplaceAccountIdsForCompany } from "../modules/settlements/import";

export const settlementsRouter = Router();
settlementsRouter.use(requireAuth, requireCompanyScope, requireSection("finance"));

/**
 * Marketplace payment/settlement-sheet reconciliation. Added 2026-09-25 per
 * user request (Hinglish): upload whatever payment report the marketplace
 * gives (Flipkart, Meesho, Snapdeal — three different multi-tab .xlsx
 * layouts) and have it auto-match against orders, with everything visible
 * against the order it belongs to, plus a full report. See
 * src/db/schema.ts's settlement_entries comment and BRAIN.md pt.11 for the
 * full design writeup, including why only some line types count toward the
 * "Amount Received" total (avoiding double-counting money a sheet like
 * GST_Details only re-explains, not separately pays).
 */

async function assertOwnsMarketplaceAccount(companyId: number, marketplaceAccountId: number) {
  const owned = await marketplaceAccountIdsForCompany(companyId);
  if (!owned.includes(marketplaceAccountId)) throw new HttpError(404, "Seller account not found in your workspace");
}

const importSchema = z.object({
  marketplaceAccountId: z.number().int().positive(),
  fileName: z.string().min(1).max(300),
  // base64-encoded .xlsx bytes — same "read client-side, POST as JSON"
  // convention the CSV order/AWB importers already use, just base64 instead
  // of plain text since this is a binary multi-sheet workbook.
  fileBase64: z.string().min(1),
});

settlementsRouter.post("/import", requireRole("OWNER", "ADMIN"), async (req, res, next) => {
  try {
    const body = importSchema.parse(req.body);
    await assertOwnsMarketplaceAccount(req.session!.companyId, body.marketplaceAccountId);

    let buffer: Buffer;
    try {
      buffer = Buffer.from(body.fileBase64, "base64");
    } catch {
      throw new HttpError(400, "Could not decode the uploaded file");
    }
    if (buffer.length === 0) throw new HttpError(400, "Uploaded file is empty");
    if (buffer.length > 25 * 1024 * 1024) throw new HttpError(400, "File is too large (25MB limit)");

    let parsed;
    try {
      parsed = parseSettlementFile(buffer);
    } catch (e) {
      throw new HttpError(400, e instanceof Error ? e.message : "Could not read this file as a payment report");
    }
    if (parsed.rows.length === 0) {
      throw new HttpError(400, "No settlement rows found in this file — check it's the full export, not a trimmed copy");
    }

    const result = await importSettlementWorkbook(body.marketplaceAccountId, body.fileName, req.session!.userId, parsed);
    res.status(201).json(result);
  } catch (err) {
    next(err);
  }
});

/** Import history — most recent first. */
settlementsRouter.get("/", async (req, res, next) => {
  try {
    const rows = await db
      .select({
        id: settlementImports.id,
        marketplace: settlementImports.marketplace,
        sourceFileName: settlementImports.sourceFileName,
        store: marketplaceAccounts.sellerAccountLabel,
        periodStart: settlementImports.periodStart,
        periodEnd: settlementImports.periodEnd,
        entryCount: settlementImports.entryCount,
        matchedCount: settlementImports.matchedCount,
        unmatchedCount: settlementImports.unmatchedCount,
        createdAt: settlementImports.createdAt,
      })
      .from(settlementImports)
      .innerJoin(marketplaceAccounts, eq(marketplaceAccounts.id, settlementImports.marketplaceAccountId))
      .innerJoin(brands, eq(brands.id, marketplaceAccounts.brandId))
      .where(eq(brands.companyId, req.session!.companyId))
      .orderBy(desc(settlementImports.createdAt))
      .limit(100);
    res.json(rows);
  } catch (err) {
    next(err);
  }
});

/**
 * The full report: totals by line type (fee category) and by marketplace
 * over a period, plus the "Amount Received" figure — deliberately summed
 * ONLY from countsAsBankMoney rows (see module comment above) so it never
 * silently double-counts a sheet like GST_Details that just re-explains a
 * fee already counted inside an ORDER_PAYMENT/ADS/etc row.
 */
const reportQuerySchema = z.object({
  start: z.string().optional(),
  end: z.string().optional(),
});
settlementsRouter.get("/report", async (req, res, next) => {
  try {
    const q = reportQuerySchema.parse(req.query);
    // Unlike Reports' Turnover tab (live orders, so "last 90 days" is the
    // useful default), settlement sheets are inherently retrospective — a
    // company might upload a Q4-last-year Flipkart report or three old
    // Meesho months on day one. Defaulting to "last 90 days" would silently
    // hide almost everything they just imported. Default to unrestricted
    // (the caller can still narrow it with ?start=&end=) so a fresh import
    // is never invisible on the report the moment it lands.
    const end = q.end ? new Date(q.end) : new Date("2100-01-01");
    const start = q.start ? new Date(q.start) : new Date("2000-01-01");

    const companyId = req.session!.companyId;

    const byType = await db
      .select({
        lineType: settlementEntries.lineType,
        marketplace: settlementImports.marketplace,
        total: sql<string>`coalesce(sum(${settlementEntries.amount}), 0)::text`,
        count: sql<number>`count(*)::int`,
        bankMoney: settlementEntries.countsAsBankMoney,
      })
      .from(settlementEntries)
      .innerJoin(settlementImports, eq(settlementImports.id, settlementEntries.settlementImportId))
      .innerJoin(marketplaceAccounts, eq(marketplaceAccounts.id, settlementEntries.marketplaceAccountId))
      .innerJoin(brands, eq(brands.id, marketplaceAccounts.brandId))
      .where(
        and(
          eq(brands.companyId, companyId),
          gte(sql`coalesce(${settlementEntries.occurredAt}, ${settlementImports.createdAt})`, start),
          lte(sql`coalesce(${settlementEntries.occurredAt}, ${settlementImports.createdAt})`, end)
        )
      )
      .groupBy(settlementEntries.lineType, settlementImports.marketplace, settlementEntries.countsAsBankMoney)
      .orderBy(settlementEntries.lineType);

    const received = byType.filter((r) => r.bankMoney).reduce((s, r) => s + Number(r.total), 0);
    const unmatchedOrderPayments = await db
      .select({ count: sql<number>`count(*)::int` })
      .from(settlementEntries)
      .innerJoin(settlementImports, eq(settlementImports.id, settlementEntries.settlementImportId))
      .innerJoin(marketplaceAccounts, eq(marketplaceAccounts.id, settlementEntries.marketplaceAccountId))
      .innerJoin(brands, eq(brands.id, marketplaceAccounts.brandId))
      .where(
        and(
          eq(brands.companyId, companyId),
          eq(settlementEntries.lineType, "ORDER_PAYMENT"),
          sql`${settlementEntries.orderId} is null`
        )
      );

    res.json({
      start: start.toISOString(),
      end: end.toISOString(),
      amountReceived: received.toFixed(2),
      byType,
      unmatchedOrderPaymentRows: unmatchedOrderPayments[0]?.count ?? 0,
    });
  } catch (err) {
    next(err);
  }
});

/** Every settlement line matched to one order — used by the order-detail modal's "Settlement" section. */
settlementsRouter.get("/entries", async (req, res, next) => {
  try {
    const orderId = Number(req.query.orderId);
    if (!Number.isInteger(orderId) || orderId <= 0) throw new HttpError(400, "orderId is required");

    const [owned] = await db
      .select({ id: orders.id })
      .from(orders)
      .innerJoin(marketplaceAccounts, eq(marketplaceAccounts.id, orders.marketplaceAccountId))
      .innerJoin(brands, eq(brands.id, marketplaceAccounts.brandId))
      .where(and(eq(orders.id, orderId), eq(brands.companyId, req.session!.companyId)))
      .limit(1);
    if (!owned) throw new HttpError(404, "Order not found in your workspace");

    const rows = await getSettlementEntriesForOrder(req.session!.companyId, orderId);
    res.json(rows);
  } catch (err) {
    next(err);
  }
});

/** Rows from a specific import that couldn't be matched to a live order — for troubleshooting a bad import. */
settlementsRouter.get("/unmatched", async (req, res, next) => {
  try {
    const importId = Number(req.query.importId);
    if (!Number.isInteger(importId) || importId <= 0) throw new HttpError(400, "importId is required");

    const [owned] = await db
      .select({ id: settlementImports.id })
      .from(settlementImports)
      .innerJoin(marketplaceAccounts, eq(marketplaceAccounts.id, settlementImports.marketplaceAccountId))
      .innerJoin(brands, eq(brands.id, marketplaceAccounts.brandId))
      .where(and(eq(settlementImports.id, importId), eq(brands.companyId, req.session!.companyId)))
      .limit(1);
    if (!owned) throw new HttpError(404, "Import not found in your workspace");

    const rows = await db
      .select({
        id: settlementEntries.id,
        lineType: settlementEntries.lineType,
        marketplaceOrderIdRaw: settlementEntries.marketplaceOrderIdRaw,
        reference: settlementEntries.reference,
        occurredAt: settlementEntries.occurredAt,
        amount: settlementEntries.amount,
      })
      .from(settlementEntries)
      .where(
        and(
          eq(settlementEntries.settlementImportId, importId),
          eq(settlementEntries.lineType, "ORDER_PAYMENT"),
          sql`${settlementEntries.orderId} is null`
        )
      )
      .limit(500);
    res.json(rows);
  } catch (err) {
    next(err);
  }
});
