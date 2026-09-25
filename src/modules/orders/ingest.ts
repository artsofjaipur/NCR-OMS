import { and, eq } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import * as schema from "../../db/schema";
import { db } from "../../db/client";
import { orders, orderItems, shipments, marketplaceSkuMap, skus } from "../../db/schema";
import { NormalizedOrder } from "../../ingestion/types";
import { lockSkuWarehouse, reserveStock } from "../inventory/ledger";

type Tx = NodePgDatabase<typeof schema>;

export class UnmappedSkuError extends Error {
  /** The raw marketplace SKU string, exposed structurally (not just in the
   * message) so a caller can offer a "map this SKU now" fix-it action
   * instead of making the user retype it from the error text. */
  public readonly marketplaceSku: string;
  constructor(marketplaceSku: string) {
    super(`No SKU mapping found for marketplace SKU "${marketplaceSku}" — fix the mapping and retry`);
    this.marketplaceSku = marketplaceSku;
  }
}

export interface IngestResult {
  orderId: number;
  created: boolean;
  /**
   * SKU codes whose recorded stock couldn't cover this order (reservation
   * still went through, see reserveStock's `strict: false`) -- surfaced so
   * the caller can tell the user "imported, but do a Stock In for these"
   * instead of the shortfall going unnoticed.
   */
  stockWarnings?: string[];
  /**
   * Marketplace SKUs this run resolved without an existing mapping already
   * on file -- see resolveSkuForItem below. User's explicit choice (asked
   * directly, see BRAIN.md): auto-resolve and never block the order, rather
   * than making every new marketplace SKU string wait for a manual "Map
   * SKU" click. Surfaced here so it's reviewable, not silent.
   */
  autoMappedSkus?: { marketplaceSku: string; skuCode: string; skuCreated: boolean }[];
}

// ---------------------------------------------------------------------------
// Marketplace-SKU auto-match — server-side port of public/app.js's
// skuMatchScore() (same algorithm, same 0.92 "confident enough" threshold)
// so bulk CSV ingestion can resolve an unmapped SKU on its own instead of
// throwing UnmappedSkuError and rolling back the whole order. See BRAIN.md:
// the user was asked directly (click-to-confirm vs fully automatic) and
// chose fully automatic for CSV imports.
// ---------------------------------------------------------------------------
function skuCompact(s: string | null | undefined): string {
  return (s || "").toUpperCase().replace(/[^A-Z0-9]/g, "");
}
function skuTokens(s: string | null | undefined): string[] {
  return (s || "").toUpperCase().split(/[^A-Z0-9]+/).filter(Boolean);
}
function levenshtein(a: string, b: string): number {
  const m = a.length;
  const n = b.length;
  if (!m) return n;
  if (!n) return m;
  let prev: number[] = [];
  for (let j = 0; j <= n; j++) prev[j] = j;
  for (let i = 1; i <= m; i++) {
    const cur: number[] = [i];
    for (let j = 1; j <= n; j++) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    prev = cur;
  }
  return prev[n];
}
function tokenJaccard(aTokens: string[], bTokens: string[]): number {
  if (!aTokens.length || !bTokens.length) return 0;
  const setA = new Set(aTokens);
  const setB = new Set(bTokens);
  let inter = 0;
  for (const t of setA) if (setB.has(t)) inter++;
  const union = setA.size + setB.size - inter;
  return union ? inter / union : 0;
}
/** 0..1 — how likely `marketplaceSku` refers to this candidate SKU. */
function skuMatchScore(marketplaceSku: string, candidateCode: string, candidateTitle: string | null): number {
  const mCompact = skuCompact(marketplaceSku);
  const mTokens = skuTokens(marketplaceSku);
  let best = 0;
  for (const c of [candidateCode, candidateTitle]) {
    const cCompact = skuCompact(c);
    if (!cCompact) continue;
    if (cCompact === mCompact) return 1;
    const lev = 1 - levenshtein(mCompact, cCompact) / Math.max(mCompact.length, cCompact.length, 1);
    const jac = tokenJaccard(mTokens, skuTokens(c));
    let combined = Math.max(lev, jac) * 0.65 + Math.min(lev, jac) * 0.35;
    if (cCompact.indexOf(mCompact) !== -1 || mCompact.indexOf(cCompact) !== -1) combined = Math.max(combined, 0.8);
    if (combined > best) best = combined;
  }
  return best;
}

const AUTO_MATCH_THRESHOLD = 0.92;

/**
 * Resolves a marketplace SKU string to an internal SKU id, auto-mapping (or
 * auto-creating) when there's no existing mapping on file yet — never
 * throws for an ordinary unmapped SKU. A confident match (>= threshold)
 * against an existing SKU in the brand's catalog gets mapped straight to
 * it; anything less confident gets a brand-new SKU created (code = the raw
 * marketplace SKU string, same convention the "Map SKU" modal's manual
 * "Create & Map" already uses) so the order is never blocked. Both paths
 * write the mapping so the same marketplace SKU resolves instantly next
 * time, exactly like a manually-mapped one would.
 */
async function resolveSkuForItem(
  tx: Tx,
  marketplaceAccountId: number,
  brandId: number,
  marketplaceSku: string,
  productTitleSnapshot: string,
): Promise<{ skuId: number; auto?: { skuCode: string; skuCreated: boolean } }> {
  const [existing] = await tx
    .select({ skuId: marketplaceSkuMap.skuId })
    .from(marketplaceSkuMap)
    .where(and(eq(marketplaceSkuMap.marketplaceAccountId, marketplaceAccountId), eq(marketplaceSkuMap.marketplaceSku, marketplaceSku)))
    .limit(1);
  if (existing) return { skuId: existing.skuId };

  const brandSkus = await tx
    .select({ id: skus.id, code: skus.code, productTitle: skus.productTitle })
    .from(skus)
    .where(eq(skus.brandId, brandId));

  let best: { id: number; code: string } | null = null;
  let bestScore = 0;
  for (const s of brandSkus) {
    const score = skuMatchScore(marketplaceSku, s.code, s.productTitle);
    if (score > bestScore) {
      bestScore = score;
      best = s;
    }
  }

  if (best && bestScore >= AUTO_MATCH_THRESHOLD) {
    await tx
      .insert(marketplaceSkuMap)
      .values({ marketplaceAccountId, marketplaceSku, skuId: best.id })
      .onConflictDoUpdate({ target: [marketplaceSkuMap.marketplaceAccountId, marketplaceSkuMap.marketplaceSku], set: { skuId: best.id } });
    return { skuId: best.id, auto: { skuCode: best.code, skuCreated: false } };
  }

  // No confident match — create rather than block. onConflictDoNothing
  // covers the same marketplaceSku appearing twice in one batch (or two
  // concurrent imports) racing to create the identical (brandId, code) row.
  const code = marketplaceSku.trim().slice(0, 100);
  const title = (productTitleSnapshot || marketplaceSku).slice(0, 300);
  if (!code) throw new UnmappedSkuError(marketplaceSku); // defensive — parsers never emit an empty SKU today

  await tx.insert(skus).values({ brandId, code, productTitle: title }).onConflictDoNothing({ target: [skus.brandId, skus.code] });
  const [resolved] = await tx
    .select({ id: skus.id, code: skus.code })
    .from(skus)
    .where(and(eq(skus.brandId, brandId), eq(skus.code, code)))
    .limit(1);
  if (!resolved) throw new UnmappedSkuError(marketplaceSku); // should not happen; safety net only

  await tx
    .insert(marketplaceSkuMap)
    .values({ marketplaceAccountId, marketplaceSku, skuId: resolved.id })
    .onConflictDoUpdate({ target: [marketplaceSkuMap.marketplaceAccountId, marketplaceSkuMap.marketplaceSku], set: { skuId: resolved.id } });

  return { skuId: resolved.id, auto: { skuCode: resolved.code, skuCreated: true } };
}

/**
 * Order creation and every line item's stock reservation happen in one
 * database transaction: a failed reservation (insufficient stock, or an
 * unmapped SKU) rolls back the *whole* order, so there is no path to an
 * order existing without a matching reservation for every item.
 *
 * Ingestion is idempotent on (marketplaceAccountId, marketplaceOrderId) —
 * re-running the same export a second time updates the existing order
 * instead of double-reserving stock.
 */
export async function ingestOrder(
  marketplaceAccountId: number,
  warehouseId: number,
  normalized: NormalizedOrder,
  brandId: number,
): Promise<IngestResult> {
  return db.transaction(async (tx) => {
    const [existing] = await tx
      .select({ id: orders.id })
      .from(orders)
      .where(and(eq(orders.marketplaceAccountId, marketplaceAccountId), eq(orders.marketplaceOrderId, normalized.marketplaceOrderId)))
      .limit(1);

    if (existing) {
      // Already ingested — status refresh only, no re-reservation.
      await tx
        .update(orders)
        .set({ status: normalized.status as any, verifiedAt: normalized.verifiedAt ?? null })
        .where(eq(orders.id, existing.id));
      return { orderId: existing.id, created: false };
    }

    const [order] = await tx
      .insert(orders)
      .values({
        marketplaceAccountId,
        marketplaceOrderId: normalized.marketplaceOrderId,
        status: normalized.status as any,
        fulfillmentType: normalized.fulfillmentType,
        invoiceNumber: normalized.invoiceNumber ?? null,
        invoiceDate: normalized.invoiceDate ?? null,
        orderedAt: normalized.orderedAt,
        verifiedAt: normalized.verifiedAt ?? null,
        rawPayload: normalized.rawPayload,
      })
      .returning({ id: orders.id });

    const stockWarnings: string[] = [];
    const autoMappedSkus: { marketplaceSku: string; skuCode: string; skuCreated: boolean }[] = [];

    for (const item of normalized.items) {
      const resolved = await resolveSkuForItem(tx, marketplaceAccountId, brandId, item.marketplaceSku, item.productTitleSnapshot);
      if (resolved.auto) autoMappedSkus.push({ marketplaceSku: item.marketplaceSku, ...resolved.auto });
      const skuId = resolved.skuId;

      await tx.insert(orderItems).values({
        orderId: order.id,
        skuId,
        marketplaceLineItemId: item.marketplaceLineItemId ?? null,
        marketplaceSku: item.marketplaceSku,
        productTitleSnapshot: item.productTitleSnapshot,
        variantSize: item.variantSize ?? null,
        quantity: item.quantity,
        unitPrice: item.unitPrice,
        mrp: item.mrp ?? null,
        shippingCharge: item.shippingCharge ?? "0",
        invoiceAmount: item.invoiceAmount ?? null,
        taxCgst: item.taxCgst ?? null,
        taxSgst: item.taxSgst ?? null,
        taxIgst: item.taxIgst ?? null,
        taxRate: item.taxRate ?? null,
        hsnCode: item.hsnCode ?? null,
        settlementPriceEstimate: item.settlementPriceEstimate ?? null,
      });

      // Advisory lock first, so the stock check below is serialized against
      // any other in-flight reservation for the same SKU in this warehouse.
      await lockSkuWarehouse(tx, skuId, warehouseId);
      // strict: false -- see reserveStock's own comment. A marketplace order
      // that's already confirmed (and often already shipped off-system)
      // should never be rejected just because this app hasn't recorded a
      // Stock In yet; going negative is flagged back to the user instead.
      const { shortfall } = await reserveStock(
        tx,
        { skuId, warehouseId, quantity: item.quantity, referenceType: "order", referenceId: String(order.id) },
        { strict: false },
      );
      if (shortfall > 0) stockWarnings.push(item.marketplaceSku);
    }

    if (normalized.shipment) {
      await tx.insert(shipments).values({
        orderId: order.id,
        warehouseId,
        ...normalized.shipment,
      });
    }

    return {
      orderId: order.id,
      created: true,
      stockWarnings: stockWarnings.length ? stockWarnings : undefined,
      autoMappedSkus: autoMappedSkus.length ? autoMappedSkus : undefined,
    };
  });
}
