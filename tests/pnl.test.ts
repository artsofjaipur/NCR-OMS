import { describe, it, expect, beforeAll, beforeEach, afterAll } from "vitest";
import { execSync } from "child_process";
import "dotenv/config";
import { sql } from "drizzle-orm";
import { db, pool } from "../src/db/client";
import { companies, brands, warehouses, marketplaceAccounts, skus, orders, orderItems, settlementLines, costEntries } from "../src/db/schema";
import { computeOrderMargin } from "../src/modules/pnl/pnl";

let orderId: number;
let skuId: number;

beforeAll(async () => {
  execSync("npx drizzle-kit push --force", { stdio: "inherit", cwd: process.cwd() });
});

beforeEach(async () => {
  await db.execute(sql`TRUNCATE TABLE
    settlement_lines, payout_batches, order_items, orders, cost_entries,
    skus, marketplace_accounts, warehouses, brands, companies
    RESTART IDENTITY CASCADE`);

  const [company] = await db.insert(companies).values({ legalName: "Casa Arra Pvt Ltd", displayName: "Casa Arra" }).returning({ id: companies.id });
  const [brand] = await db.insert(brands).values({ companyId: company.id, name: "Kanjush" }).returning({ id: brands.id });
  await db.insert(warehouses).values({ companyId: company.id, name: "WH" });
  const [account] = await db
    .insert(marketplaceAccounts)
    .values({ brandId: brand.id, marketplace: "SNAPDEAL", sellerAccountLabel: "Seller", credentialsEncrypted: "unused" })
    .returning({ id: marketplaceAccounts.id });

  const [sku] = await db.insert(skus).values({ brandId: brand.id, code: "PNL-SKU", productTitle: "Dress" }).returning({ id: skus.id });
  skuId = sku.id;

  const orderedAt = new Date("2026-08-15T00:00:00Z");
  await db.insert(costEntries).values({ skuId, unitCost: "250.00", effectiveFrom: new Date("2026-01-01T00:00:00Z") });

  const [order] = await db
    .insert(orders)
    .values({ marketplaceAccountId: account.id, marketplaceOrderId: "PNL-1", orderedAt, status: "DELIVERED" })
    .returning({ id: orders.id });
  orderId = order.id;

  await db.insert(orderItems).values({ orderId, skuId, marketplaceSku: "PNL-SKU", productTitleSnapshot: "Dress", quantity: 1, unitPrice: "499.00", invoiceAmount: "499.00" });

  const [batch] = await db
    .insert((await import("../src/db/schema")).payoutBatches)
    .values({ marketplaceAccountId: account.id, expectedDate: orderedAt, expectedAmount: "499.00", status: "RECONCILED" })
    .returning({ id: (await import("../src/db/schema")).payoutBatches.id });
  await db.insert(settlementLines).values({ payoutBatchId: batch.id, orderId, expectedAmount: "499.00", paidAmount: "499.00", variance: "0.00" });
});

afterAll(async () => {
  await pool.end();
});

describe("P&L", () => {
  it("computes contribution margin as settled amount minus period-dated COGS", async () => {
    const margin = await computeOrderMargin(orderId);
    expect(margin.settledAmount).toBe(499);
    expect(margin.cogs).toBe(250);
    expect(margin.contributionMargin).toBe(249);
  });
});
