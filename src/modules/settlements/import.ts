import { and, eq } from "drizzle-orm";
import { db } from "../../db/client";
import { orders, orderItems, settlementImports, settlementEntries, payoutBatches, marketplaceAccounts, brands } from "../../db/schema";
import { ParsedSettlementRow, ParsedSettlementWorkbook } from "../../ingestion/parsers/settlements";

/** Flipkart text-guards numeric-looking IDs with a leading apostrophe in some exports; strip it defensively (matches src/ingestion/parsers/flipkart.ts's own stripTextGuard). */
function stripGuard(v: string): string {
  return v.startsWith("'") ? v.slice(1) : v;
}

/** Meesho's "Sub Order No" is `<order id>_<line sequence>` — same split rule as src/ingestion/parsers/meesho.ts. */
function splitSubOrderNo(subOrderNo: string): { orderId: string; lineSeq: string } {
  const idx = subOrderNo.lastIndexOf("_");
  if (idx === -1) return { orderId: subOrderNo, lineSeq: "1" };
  return { orderId: subOrderNo.slice(0, idx), lineSeq: subOrderNo.slice(idx + 1) };
}

interface OrderLink {
  orderId: number | null;
  orderItemId: number | null;
}

/**
 * Resolves one settlement row's raw order/line-item identifiers into real
 * `orders`/`order_items` rows, using whichever convention its marketplace's
 * own order-ingestion parser already established (see types.ts's
 * OrderMatchStrategy for the mapping). Caches per-orderId lookups within one
 * import so a multi-line order (many settlement rows sharing one Order ID)
 * doesn't re-query the same order repeatedly.
 */
class OrderMatcher {
  private orderCache = new Map<string, number | null>(); // `${marketplaceAccountId}:${marketplaceOrderId}` -> orders.id | null
  private lineItemCache = new Map<string, { orderId: number; id: number } | null>(); // `${orderId}:${lineItemId}` -> order_items row | null
  private crossAccountLineItemCache = new Map<string, { orderId: number; id: number } | null>(); // `${marketplaceAccountId}:${lineItemId}` -> order_items row | null

  constructor(private marketplaceAccountId: number) {}

  private async findOrderId(marketplaceOrderId: string): Promise<number | null> {
    const key = `${this.marketplaceAccountId}:${marketplaceOrderId}`;
    if (this.orderCache.has(key)) return this.orderCache.get(key)!;
    const [row] = await db
      .select({ id: orders.id })
      .from(orders)
      .where(and(eq(orders.marketplaceAccountId, this.marketplaceAccountId), eq(orders.marketplaceOrderId, marketplaceOrderId)))
      .limit(1);
    const id = row?.id ?? null;
    this.orderCache.set(key, id);
    return id;
  }

  private async findLineItem(orderId: number, lineItemId: string): Promise<{ orderId: number; id: number } | null> {
    const key = `${orderId}:${lineItemId}`;
    if (this.lineItemCache.has(key)) return this.lineItemCache.get(key)!;
    const [row] = await db
      .select({ id: orderItems.id, orderId: orderItems.orderId })
      .from(orderItems)
      .where(and(eq(orderItems.orderId, orderId), eq(orderItems.marketplaceLineItemId, lineItemId)))
      .limit(1);
    const val = row ?? null;
    this.lineItemCache.set(key, val);
    return val;
  }

  private async findLineItemAcrossAccount(lineItemId: string): Promise<{ orderId: number; id: number } | null> {
    const key = `${this.marketplaceAccountId}:${lineItemId}`;
    if (this.crossAccountLineItemCache.has(key)) return this.crossAccountLineItemCache.get(key)!;
    const [row] = await db
      .select({ id: orderItems.id, orderId: orderItems.orderId })
      .from(orderItems)
      .innerJoin(orders, eq(orders.id, orderItems.orderId))
      .where(and(eq(orders.marketplaceAccountId, this.marketplaceAccountId), eq(orderItems.marketplaceLineItemId, lineItemId)))
      .limit(1);
    const val = row ?? null;
    this.crossAccountLineItemCache.set(key, val);
    return val;
  }

  async resolve(r: ParsedSettlementRow): Promise<OrderLink> {
    if (!r.matchStrategy) return { orderId: null, orderItemId: null };

    if (r.matchStrategy === "FLIPKART_ORDER_ITEM") {
      if (!r.marketplaceOrderIdRaw) return { orderId: null, orderItemId: null };
      const orderId = await this.findOrderId(stripGuard(r.marketplaceOrderIdRaw));
      if (!orderId) return { orderId: null, orderItemId: null };
      if (!r.orderItemRaw) return { orderId, orderItemId: null };
      const item = await this.findLineItem(orderId, stripGuard(r.orderItemRaw));
      return { orderId, orderItemId: item?.id ?? null };
    }

    if (r.matchStrategy === "MEESHO_SUBORDER") {
      if (!r.marketplaceOrderIdRaw) return { orderId: null, orderItemId: null };
      const { orderId: base, lineSeq } = splitSubOrderNo(r.marketplaceOrderIdRaw);
      const orderId = await this.findOrderId(base);
      if (!orderId) return { orderId: null, orderItemId: null };
      const item = await this.findLineItem(orderId, lineSeq);
      return { orderId, orderItemId: item?.id ?? null };
    }

    if (r.matchStrategy === "LINE_ITEM_ID_ONLY") {
      if (!r.orderItemRaw) return { orderId: null, orderItemId: null };
      const item = await this.findLineItemAcrossAccount(stripGuard(r.orderItemRaw));
      if (!item) return { orderId: null, orderItemId: null };
      return { orderId: item.orderId, orderItemId: item.id };
    }

    return { orderId: null, orderItemId: null };
  }
}

export interface ImportSettlementResult {
  importId: number;
  marketplace: string;
  entryCount: number;
  matchedCount: number;
  unmatchedCount: number;
  unrecognizedSheets: string[];
  payoutBatchesTouched: number;
}

/**
 * Ingests one parsed settlement workbook: writes a settlement_imports row,
 * one settlement_entries row per source line (order-matched where possible),
 * and — for every lineType that's a literal bank-credit record
 * (`countsAsBankMoney`) — creates or updates a `payout_batches` row grouped
 * by its NEFT/UTR/transaction reference, so Finance's existing "Money In"
 * totals and cashflow chart reflect the real settlement the moment it's
 * imported, without the user re-entering it by hand via "Confirm Received".
 * Re-importing the same file is safe and idempotent, same promise the CSV
 * order/AWB importers already make ("duplicates are updated, not
 * re-created — re-uploading is always safe"): a prior import with the exact
 * same (marketplaceAccountId, sourceFileName) is deleted — cascading to its
 * settlement_entries — before the fresh one is written, so re-uploading the
 * same file (or a re-download of the same period with a couple more rows
 * appended) replaces rather than doubles it. Payout batches are separately
 * upserted by bank reference either way.
 */
export async function importSettlementWorkbook(
  marketplaceAccountId: number,
  sourceFileName: string,
  importedByUserId: number,
  parsed: ParsedSettlementWorkbook
): Promise<ImportSettlementResult> {
  await db
    .delete(settlementImports)
    .where(and(eq(settlementImports.marketplaceAccountId, marketplaceAccountId), eq(settlementImports.sourceFileName, sourceFileName)));

  const [importRow] = await db
    .insert(settlementImports)
    .values({
      marketplaceAccountId,
      marketplace: parsed.marketplace,
      sourceFileName,
      periodStart: parsed.periodStart,
      periodEnd: parsed.periodEnd,
      importedByUserId,
    })
    .returning({ id: settlementImports.id });

  const matcher = new OrderMatcher(marketplaceAccountId);
  let matchedCount = 0;

  // Grouped by bank reference, for the payout-batch upsert below.
  const bankGroups = new Map<string, { total: number; earliest: Date | null; latest: Date | null }>();

  const VALUES: (typeof settlementEntries.$inferInsert)[] = [];
  for (const r of parsed.rows) {
    const link = await matcher.resolve(r);
    if (link.orderId) matchedCount++;

    VALUES.push({
      settlementImportId: importRow.id,
      marketplaceAccountId,
      lineType: r.lineType,
      orderId: link.orderId,
      orderItemId: link.orderItemId,
      marketplaceOrderIdRaw: r.marketplaceOrderIdRaw ?? r.orderItemRaw,
      reference: r.reference,
      occurredAt: r.occurredAt,
      amount: r.amount.toFixed(2),
      countsAsBankMoney: r.countsAsBankMoney,
      raw: r.raw,
    });

    if (r.countsAsBankMoney) {
      const key = r.reference ?? `__no_reference__:${r.lineType}`;
      const g = bankGroups.get(key) ?? { total: 0, earliest: null, latest: null };
      g.total += r.amount;
      if (r.occurredAt) {
        if (!g.earliest || r.occurredAt < g.earliest) g.earliest = r.occurredAt;
        if (!g.latest || r.occurredAt > g.latest) g.latest = r.occurredAt;
      }
      bankGroups.set(key, g);
    }
  }

  // Bulk insert entries in chunks (defensive — some real files run into the
  // hundreds of rows across all tabs combined; stay well under Postgres's
  // per-statement parameter limit).
  const CHUNK = 200;
  for (let i = 0; i < VALUES.length; i += CHUNK) {
    if (VALUES.slice(i, i + CHUNK).length > 0) {
      await db.insert(settlementEntries).values(VALUES.slice(i, i + CHUNK));
    }
  }

  // Upsert one payout_batches row per real (non-synthetic) bank reference —
  // synthetic `__no_reference__:*` groups (a bank-money row with no NEFT/UTR
  // captured) are skipped: there's nothing stable to key a batch on, and the
  // underlying entries are still fully visible in the settlements report.
  let payoutBatchesTouched = 0;
  for (const [reference, g] of bankGroups) {
    if (reference.startsWith("__no_reference__:")) continue;
    const amount = g.total.toFixed(2);
    const date = g.earliest ?? g.latest ?? new Date();
    const [existing] = await db
      .select({ id: payoutBatches.id })
      .from(payoutBatches)
      .where(and(eq(payoutBatches.marketplaceAccountId, marketplaceAccountId), eq(payoutBatches.bankReference, reference)))
      .limit(1);
    if (existing) {
      await db
        .update(payoutBatches)
        .set({ receivedAmount: amount, receivedDate: date, status: "RECONCILED" })
        .where(eq(payoutBatches.id, existing.id));
    } else {
      await db.insert(payoutBatches).values({
        marketplaceAccountId,
        expectedDate: date,
        expectedAmount: amount,
        receivedDate: date,
        receivedAmount: amount,
        bankReference: reference,
        status: "RECONCILED",
      });
    }
    payoutBatchesTouched++;
  }

  const unmatchedCount = VALUES.length - matchedCount;
  await db
    .update(settlementImports)
    .set({ entryCount: VALUES.length, matchedCount, unmatchedCount })
    .where(eq(settlementImports.id, importRow.id));

  return {
    importId: importRow.id,
    marketplace: parsed.marketplace,
    entryCount: VALUES.length,
    matchedCount,
    unmatchedCount,
    unrecognizedSheets: parsed.unrecognizedSheets,
    payoutBatchesTouched,
  };
}

/** Used by GET /settlements/entries?orderId= — every settlement line ever matched to this order, newest import first. */
export async function getSettlementEntriesForOrder(companyId: number, orderId: number) {
  const rows = await db
    .select({
      id: settlementEntries.id,
      lineType: settlementEntries.lineType,
      reference: settlementEntries.reference,
      occurredAt: settlementEntries.occurredAt,
      amount: settlementEntries.amount,
      countsAsBankMoney: settlementEntries.countsAsBankMoney,
      raw: settlementEntries.raw,
      importId: settlementEntries.settlementImportId,
    })
    .from(settlementEntries)
    .where(eq(settlementEntries.orderId, orderId));
  return rows;
}

/** Guard used by the route: only marketplace-account IDs the caller's own company owns (scoped via brands.companyId, the same chain finance.ts/orders.ts already use). */
export async function marketplaceAccountIdsForCompany(companyId: number): Promise<number[]> {
  const rows = await db
    .select({ id: marketplaceAccounts.id })
    .from(marketplaceAccounts)
    .innerJoin(brands, eq(brands.id, marketplaceAccounts.brandId))
    .where(eq(brands.companyId, companyId));
  return rows.map((r) => r.id);
}
