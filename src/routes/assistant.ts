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
 * Deterministic intent engine answers from live data; when
 * AI_GATEWAY_API_KEY is configured, low-confidence questions are enriched
 * through the Vercel AI Gateway.
 * User-facing copy switched from Hinglish to English by Claude (Anthropic)
 * 2026-09-11 (see BRAIN.md) — the `has()` keyword matching below already
 * accepted both languages for most intents, so this only changes what the
 * assistant SAYS back, not what it understands.
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
      alerts.push({ type: "dispatch", severity: "high", message: `${s.pendingPack.count} orders are pending dispatch — pack them and scan the AWB at Scan Station.` });
    if (s.payoutsPending.count > 0)
      alerts.push({ type: "payout", severity: "high", message: `${s.payoutsPending.count} store payouts awaited — ₹${Math.round(s.payoutsPending.amount).toLocaleString("en-IN")} still due in the bank.` });
    if (s.openReturns.count > 0)
      alerts.push({ type: "returns", severity: "medium", message: `${s.openReturns.count} returns are open (initiated/in-transit) — receive-scan still pending.` });
    if (s.lowStock.length > 0)
      alerts.push({ type: "stock", severity: "medium", message: `${s.lowStock.length} SKUs are low/zero on stock: ${s.lowStock.slice(0, 4).map((x) => x.code).join(", ")}${s.lowStock.length > 4 ? "…" : ""} — bring in stock from your supplier.` });

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
        `In the last 24h, **${s.todayOrders.count} orders** came in, worth ${inrFmt(s.todayOrders.gmv)}. ` +
        (s.pendingPack.count > 0
          ? `${s.pendingPack.count} of these are pending dispatch — pack them and scan at Scan Station.`
          : `Nothing pending dispatch. 👍`);
    } else if (has("pending", "packing", "pack", "dispatch", "bhejna")) {
      confidence = 0.9;
      answer = s.pendingPack.count
        ? `**${s.pendingPack.count} orders are pending dispatch.** Open Scan Station — scanning the AWB moves them to READY_TO_DISPATCH/tracked.`
        : `No orders are pending dispatch. ✅`;
    } else if (has("payout", "paisa", "bank", "kitna aaya", "store se")) {
      confidence = 0.9;
      answer = s.payoutsPending.count
        ? `**${s.payoutsPending.count} payouts are awaited** — a total of ${inrFmt(s.payoutsPending.amount)} is still due in the bank. See Finance → Store Money-In for details.`
        : `No payouts pending. ✅`;
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
        ? `Parties (by purchase bills):\n` +
          rows.map((r) => `• ${r.name} — ${inrFmt(r.bills)}`).join("\n") +
          `\n\nTotal party bills: ${inrFmt(s.partyBills)}. Net balance (after payments/notes) is in Finance → Parties.`
        : `No parties added yet — add one under Setup.`;
    } else if (has("return", "wapas", "lauta")) {
      confidence = 0.9;
      answer = s.openReturns.count
        ? `**${s.openReturns.count} returns are open** (initiated/in-transit). When the box arrives, scan it at Scan Station → Return Receive, then QC → Restock.`
        : `No returns are open. ✅`;
    } else if (has("stock", "inventory", "khatam")) {
      confidence = 0.85;
      answer = s.lowStock.length
        ? `Low/zero stock SKUs:\n` +
          s.lowStock.map((x) => `• ${x.code} — ${x.onHand} left${x.title ? ` (${x.title})` : ""}`).join("\n") +
          `\n\nAdd stock against a party bill under Setup → Stock In.`
        : `All SKUs look fine on stock (none at ≤5 units). ✅`;
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
          `\n\nA day-wise chart + store split is in Reports → Turnover.`
        : `No orders imported yet — try a CSV upload or Single Entry from the dashboard.`;
    } else if (has("profit", "munafa", "pnl", "loss", "kharch")) {
      confidence = 0.8;
      answer = `The P&L waterfall is in Reports → Profit & Loss: GMV − store fees = payout received, minus party purchases + expenses gives net profit. You'll find exact numbers there.`;
    } else if (has("kaise", "how", "kya kar", "help", "madad", "setup", "shuru")) {
      confidence = 0.95;
      answer =
        `I'm your OMS assistant. You can ask things like:\n` +
        `• "how many orders came in today?"\n• "pending dispatch?"\n• "how much money is due from stores?"\n` +
        `• "party outstanding?"\n• "return status?"\n• "low stock?"\n• "brand-wise sale?"\n\n` +
        `Setup order: Company (registration) → Brand → Seller account (store) → SKU + mapping → Stock In → CSV upload → Pack scan → Dispatch.`;
    }

    // AI enrichment via Vercel AI Gateway when a key exists and local intents
    // miss — widened by Claude (Anthropic) 2026-09-11 (see BRAIN.md) so the
    // assistant isn't just an OMS-data lookup: general knowledge and casual
    // chat now get a real, warm answer too (Gemini-like), not a redirect to
    // "check the Reports section". OMS questions the deterministic matcher
    // above already caught still answer instantly from live data, for free —
    // this only fires on the remainder. Requires AI_GATEWAY_API_KEY to be
    // set in the deployment's env; without it this block is skipped and the
    // canned fallback further below still answers OMS questions fine, just
    // without the general-knowledge/chit-chat range.
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
            max_tokens: 500,
            messages: [
              {
                role: "system",
                content:
                  "You are the virtual assistant embedded in an Indian D2C OMS (order management system) — warm, friendly, and personable, in the spirit of Google Gemini: helpful for anything the user brings up, not only OMS questions. When the question is about the business, answer from the live OMS data given below. For general-knowledge questions, current-events-sounding questions your training data can't confirm, or just casual chat, answer naturally and warmly like a well-rounded assistant would, and say plainly when you're not sure or when something needs checking on the live web rather than guessing. Keep answers reasonably concise and friendly. Reply in English unless the user writes in another language, in which case match theirs.",
              },
              { role: "user", content: `Live OMS data for this business: ${context}\n\nUser: ${question}` },
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
        `I'm not confident about that. Try one of these:\n` +
        `• "today's orders"\n• "pending dispatch"\n• "payout status"\n• "party outstanding"\n• "low stock"\n• "brand-wise sale"`;
    }

    res.json({ answer });
  } catch (err) {
    next(err);
  }
});
