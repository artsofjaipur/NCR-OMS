import { Router } from "express";
import { and, desc, eq, inArray, sql } from "drizzle-orm";
import { z } from "zod";
import { db } from "../db/client";
import { brands, orders, orderItems, warehouses, marketplaceAccounts, skus, returns } from "../db/schema";
import { requireAuth, requireCompanyScope } from "../middleware/auth";
import { requireSection } from "../security/permissions";
import { HttpError } from "../middleware/errorHandler";
import { parseFlipkartExport } from "../ingestion/parsers/flipkart";
import { parseMeeshoExport } from "../ingestion/parsers/meesho";
import { parseSnapdealExport } from "../ingestion/parsers/snapdeal";
import { ingestOrder, UnmappedSkuError } from "../modules/orders/ingest";
import { InsufficientStockError } from "../modules/inventory/ledger";

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

    // Same per-order transaction + per-order error reporting as the manual path.
    const results: { marketplaceOrderId: string; orderId?: number; created?: boolean; error?: string }[] = [];
    for (const normalized of normalizedOrders) {
      try {
        const result = await ingestOrder(body.marketplaceAccountId, body.warehouseId, normalized);
        results.push({ marketplaceOrderId: normalized.marketplaceOrderId, orderId: result.orderId, created: result.created });
      } catch (err) {
        const message =
          err instanceof UnmappedSkuError || err instanceof InsufficientStockError ? err.message : "Ingestion failed for this order";
        results.push({ marketplaceOrderId: normalized.marketplaceOrderId, error: message });
      }
    }

    res.status(207).json({
      marketplace,
      imported: results.filter((r) => r.orderId).length,
      failed: results.filter((r) => r.error).length,
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
