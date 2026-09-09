import { Router } from "express";
import { z } from "zod";
import { and, desc, eq, gte, inArray, isNull, sql } from "drizzle-orm";
import { db } from "../db/client";
import {
  brands,
  marketplaceAccounts,
  orderItems,
  orders,
  payoutBatches,
  purchaseEntries,
  returns,
  skus,
  suppliers,
  inventoryLedger,
} from "../db/schema";
import { requireAuth, requireCompanyScope } from "../middleware/auth";

/**
 * Virtual Assistant — "alert + flart" layer over the OMS.
 * Read-only, company-scoped (the company scope flows through
 * marketplaceAccounts.brandId → orders, same as the dashboard).
 * Deterministic Hinglish intent engine answers from live data; when
 * AI_GATEWAY_API_KEY is configured, low-confidence questions are enriched
 * through the Vercel AI Gateway.
 */
export const assistantRouter = Router();
assistantRouter.use(requireAuth, requireCompanyScope);

const orderScope = and(
  eq(brands.companyId, sql`brands.company_id`),
  eq(marketplaceAccounts.brandId, orders.marketplaceAccountId),
);

async function companyStats(companyId: number) {
  const dayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000);
  const scope = eq(brands.companyId, companyId);

  const [todayRow] = await db
    .select({
      count: sql<number>`count(distinct ${orders.id})::int`,
      gmv: sql<number>`coalesce(sum(${orderItems.invoiceAmount}), 0)::float`,
    })
    .from(orders)
    .innerJoin(marketplaceAccounts, eq(marketplaceAccounts.id, orders.marketplaceAccountId))
    .innerJoin(brands, eq(brands.id, marketplaceAccounts.brandId))
    .leftJoin(orderItems, eq(orderItems.orderId, orders.id))
    .where(and(scope, gte(orders.orderedAt, dayAgo)));

  const [pendingPack] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(orders)
    .innerJoin(marketplaceAccounts, eq(marketplaceAccounts.id, orders.marketplaceAccountId))
    .innerJoin(brands, eq(brands.id, marketplaceAccounts.brandId))
    .where(and(scope, inArray(orders.status, ["CREATED", "READY_TO_DISPATCH"] as const)));

  const [openReturns] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(returns)
    .innerJoin(orders, eq(orders.id, returns.orderId))
    .innerJoin(marketplaceAccounts, eq(marketplaceAccounts.id, orders.marketplaceAccountId))
    .innerJoin(brands, eq(brands.id, marketplaceAccounts.brandId))
    .where(and(scope, inArray(returns.status, ["INITIATED", "IN_TRANSIT"] as const)));

  const [payoutsPending] = await db
    .select({
      count: sql<number>`count(*)::int`,
      amount: sql<number>`coalesce(sum(${payoutBatches.expectedAmount} - coalesce(${payoutBatches.receivedAmount}, 0)), 0)::float`,
    })
    .from(payoutBatches)
    .innerJoin(marketplaceAccounts, eq(marketplaceAccounts.id, payoutBatches.marketplaceAccountId))
    .innerJoin(brands, eq(brands.id, marketplaceAccounts.brandId))
    .where(and(scope, isNull(payoutBatches.receivedDate)));

  const [partyDues] = await db
    .select({ bills: sql<number>`coalesce(sum(${purchaseEntries.totalAmount}), 0)::float` })
    .from(purchaseEntries)
    .where(eq(purchaseEntries.companyId, companyId));

  const lowStock = await db
    .select({
      code: skus.code,
      title: skus.productTitle,
      onHand: sql<number>`coalesce(sum(${inventoryLedger.delta}), 0)::int`,
    })
    .from(skus)
    .innerJoin(brands, eq(brands.id, skus.brandId))
    .leftJoin(inventoryLedger, eq(inventoryLedger.skuId, skus.id))
    .where(scope)
    .groupBy(skus.id, skus.code, skus.productTitle)
    .having(sql`coalesce(sum(${inventoryLedger.delta}), 0) <= 5`)
    .orderBy(sql`coalesce(sum(${inventoryLedger.delta}), 0) asc`)
    .limit(8);

  return {
    todayOrders: { count: todayRow?.count ?? 0, gmv: todayRow?.gmv ?? 0 },
    pendingPack: pendingPack,
    openReturns: openReturns,
    payoutsPending,
    partyBills: partyDues.bills,
    lowStock,
  };
}

assistantRouter.get("/alerts", async (req, res, next) => {
  try {
    const companyId = req.session!.companyId;
    const s = await companyStats(companyId);

    const alerts: Array<{ type: string; severity: "high" | "medium" | "low"; message: string }> = [];
    if (s.pendingPack.count > 0)
      alerts.push({ type: "dispatch", severity: "high", message: `${s.pendingPack.count} orders dispatch-pending hain — pack karke Scan Station me AWB scan karo.` });
    if (s.payoutsPending.count > 0)
      alerts.push({ type: "payout", severity: "high", message: `${s.payoutsPending.count} store payouts awaited — ₹${Math.round(s.payoutsPending.amount).toLocaleString("en-IN")} bank me aana hai.` });
    if (s.openReturns.count > 0)
      alerts.push({ type: "returns", severity: "medium", message: `${s.openReturns.count} returns open hain (initiated/in-transit) — receive scan karna baaki.` });
    if (s.lowStock.length > 0)
      alerts.push({ type: "stock", severity: "medium", message: `${s.lowStock.length} SKUs low/zero stock: ${s.lowStock.slice(0, 4).map((x) => x.code).join(", ")}${s.lowStock.length > 4 ? "…" : ""} — party se stock in karo.` });

    res.json({ count: alerts.length, alerts });
  } catch (err) {
    next(err);
  }
});

const querySchema = z.object({ question: z.string().trim().min(1).max(500) });

function inrFmt(n: number) {
  return "₹" + Number(n || 0).toLocaleString("en-IN", { maximumFractionDigits: 0 });
}

assistantRouter.post("/query", async (req, res, next) => {
  try {
    const { question } = querySchema.parse(req.body);
    const companyId = req.session!.companyId;
    const q = question.toLowerCase();
    const s = await companyStats(companyId);

    let answer = "";
    let confidence = 0;
    const has = (...words: string[]) => words.some((w) => q.includes(w));

    if (has("aaj", "today", "aj ka", "kitne order", "order aaye")) {
      confidence = 0.9;
      answer =
        `Aaj (24h) **${s.todayOrders.count} orders** aaye hain, value ${inrFmt(s.todayOrders.gmv)}. ` +
        (s.pendingPack.count > 0
          ? `Inme se ${s.pendingPack.count} dispatch-pending hain — pack karke Scan Station me scan karo.`
          : `Dispatch-pending kuch nahi. 👍`);
    } else if (has("pending", "packing", "pack", "dispatch", "bhejna")) {
      confidence = 0.9;
      answer = s.pendingPack.count
        ? `**${s.pendingPack.count} orders dispatch-pending** hain. Scan Station kholo — AWB scan karte hi READY_TO_DISPATCH/track ho jayenge.`
        : `Koi order dispatch-pending nahi hai. ✅`;
    } else if (has("payout", "paisa", "bank", "kitna aaya", "store se")) {
      confidence = 0.9;
      answer = s.payoutsPending.count
        ? `**${s.payoutsPending.count} payouts awaited** hain — total ${inrFmt(s.payoutsPending.amount)} bank me aana baaki. Finance → Store Money-In me detail hai.`
        : `Koi payout pending nahi. ✅`;
    } else if (has("party", "supplier", "udhaar", "udhar", "outstanding", "payable", "bill")) {
      const rows = await db
        .select({
          name: suppliers.name,
          bills: sql<number>`coalesce(sum(${purchaseEntries.totalAmount}), 0)::float`,
        })
        .from(suppliers)
        .leftJoin(purchaseEntries, eq(purchaseEntries.supplierId, suppliers.id))
        .where(eq(suppliers.companyId, companyId))
        .groupBy(suppliers.id, suppliers.name)
        .orderBy(desc(sql`coalesce(sum(${purchaseEntries.totalAmount}), 0)`))
        .limit(5);
      confidence = 0.85;
      answer = rows.length
        ? `Parties (purchase bills ke hisaab se):\n` +
          rows.map((r) => `• ${r.name} — ${inrFmt(r.bills)}`).join("\n") +
          `\n\nTotal party bills: ${inrFmt(s.partyBills)}. Net balance (payments/notes ke baad) Finance → Parties me hai.`
        : `Abhi koi party add nahi hui — Setup me Party add karo.`;
    } else if (has("return", "wapas", "lauta")) {
      confidence = 0.9;
      answer = s.openReturns.count
        ? `**${s.openReturns.count} returns open** hain (initiated/in-transit). Box aane par Scan Station → Return Receive scan karo, phir QC → Restock.`
        : `Koi return open nahi hai. ✅`;
    } else if (has("stock", "inventory", "khatam")) {
      confidence = 0.85;
      answer = s.lowStock.length
        ? `Low/zero stock SKUs:\n` +
          s.lowStock.map((x) => `• ${x.code} — ${x.onHand} left${x.title ? ` (${x.title})` : ""}`).join("\n") +
          `\n\nSetup → Stock In se party bill ke against stock add karo.`
        : `Sab SKUs me stock theek hai (koi ≤5 units nahi). ✅`;
    } else if (has("brand", "sale", "bikri", "gmv", "turnover")) {
      const rows = await db
        .select({
          brand: brands.name,
          count: sql<number>`count(distinct ${orders.id})::int`,
          gmv: sql<number>`coalesce(sum(${orderItems.invoiceAmount}), 0)::float`,
        })
        .from(orders)
        .innerJoin(marketplaceAccounts, eq(marketplaceAccounts.id, orders.marketplaceAccountId))
        .innerJoin(brands, eq(brands.id, marketplaceAccounts.brandId))
        .leftJoin(orderItems, eq(orderItems.orderId, orders.id))
        .where(eq(brands.companyId, companyId))
        .groupBy(brands.id, brands.name)
        .orderBy(desc(sql`coalesce(sum(${orderItems.invoiceAmount}), 0)`))
        .limit(6);
      confidence = 0.85;
      answer = rows.length
        ? `Brand-wise sales (all time):\n` +
          rows.map((r) => `• ${r.brand} — ${r.count} orders, ${inrFmt(r.gmv)}`).join("\n") +
          `\n\nDin-wise chart + store split Reports → Turnover me hai.`
        : `Abhi koi order import nahi hua — dashboard se CSV upload ya Single Entry try karo.`;
    } else if (has("profit", "munafa", "pnl", "loss", "kharch")) {
      confidence = 0.8;
      answer = `P&L ka waterfall Reports → Profit & Loss me hai: GMV − store fees = payout received, usme se party purchases + expenses kat kar net profit banta hai. Wahan exact numbers milenge.`;
    } else if (has("kaise", "how", "kya kar", "help", "madad", "setup", "shuru")) {
      confidence = 0.95;
      answer =
        `Main tumhara OMS assistant hoon. Ye poochh sakte ho:\n` +
        `• "aaj kitne order aaye?"\n• "pending dispatch kitna?"\n• "store se kitna paisa aana baaki?"\n` +
        `• "party ka outstanding?"\n• "return status?"\n• "low stock?"\n• "brand-wise sale?"\n\n` +
        `Setup order: Company (registration) → Brand → Seller account (store) → SKU + mapping → Stock In → CSV upload → Pack scan → Dispatch.`;
    }

    // AI enrichment via Vercel AI Gateway when a key exists and local intents miss.
    if (confidence < 0.6 && process.env.AI_GATEWAY_API_KEY) {
      try {
        const context = [
          `orders last 24h: ${s.todayOrders.count} (value ${s.todayOrders.gmv})`,
          `dispatch-pending: ${s.pendingPack.count}`,
          `open returns: ${s.openReturns.count}`,
          `payouts awaited: ${s.payoutsPending.count} (${s.payoutsPending.amount})`,
          `party bills total: ${s.partyBills}`,
          `low stock: ${s.lowStock.map((x) => `${x.code}=${x.onHand}`).join(", ") || "none"}`,
        ].join("; ");
        const r = await fetch("https://ai-gateway.vercel.sh/v1/chat/completions", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${process.env.AI_GATEWAY_API_KEY}`,
          },
          body: JSON.stringify({
            model: "openai/gpt-4o-mini",
            max_tokens: 300,
            messages: [
              {
                role: "system",
                content:
                  "Tum ek Indian D2C OMS ka virtual assistant ho. Hinglish me chhote, seedhe jawab do. Sirf diye gaye live data ka use karo; data me jo nahi hai uske liye sahi section ki taraf point karo (Finance, Reports, Scan Station, Setup).",
              },
              { role: "user", content: `Live data: ${context}\n\nUser: ${question}` },
            ],
          }),
          signal: AbortSignal.timeout(15000),
        });
        if (r.ok) {
          const j = (await r.json()) as { choices?: Array<{ message?: { content?: string } }> };
          const ai = j.choices?.[0]?.message?.content;
          if (ai) answer = ai.trim();
        }
      } catch {
        // AI unavailable — canned help below still answers.
      }
    }

    if (!answer) {
      answer =
        `Ye main pakka nahi bata sakta. Ye try karo:\n` +
        `• "aaj ke orders"\n• "pending dispatch"\n• "payout status"\n• "party outstanding"\n• "low stock"\n• "brand-wise sale"`;
    }

    res.json({ answer });
  } catch (err) {
    next(err);
  }
});
