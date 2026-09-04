import { describe, it, expect, beforeAll, beforeEach, afterAll } from "vitest";
import { execSync } from "child_process";
import "dotenv/config";
import { sql } from "drizzle-orm";
import { db, pool } from "../src/db/client";
import { companies, brands, marketplaceAccounts, orders, settlementLines } from "../src/db/schema";
import { pullExpectedPayout, confirmReceivedPayout } from "../src/modules/payouts/payouts";

let marketplaceAccountId: number;
let orderIds: number[];

beforeAll(async () => {
  execSync("npx drizzle-kit push --force", { stdio: "inherit", cwd: process.cwd() });
});

beforeEach(async () => {
  await db.execute(sql`TRUNCATE TABLE
    settlement_lines, payout_batches, orders, marketplace_accounts, brands, companies
    RESTART IDENTITY CASCADE`);

  const [company] = await db.insert(companies).values({ legalName: "Rugara Pvt Ltd", displayName: "Rugara" }).returning({ id: companies.id });
  const [brand] = await db.insert(brands).values({ companyId: company.id, name: "Arvagam" }).returning({ id: brands.id });
  const [account] = await db
    .insert(marketplaceAccounts)
    .values({ brandId: brand.id, marketplace: "MEESHO", sellerAccountLabel: "Test Seller", credentialsEncrypted: "unused" })
    .returning({ id: marketplaceAccounts.id });
  marketplaceAccountId = account.id;

  const inserted = await db
    .insert(orders)
    .values([
      { marketplaceAccountId, marketplaceOrderId: "A1", orderedAt: new Date(), status: "DELIVERED" },
      { marketplaceAccountId, marketplaceOrderId: "A2", orderedAt: new Date(), status: "DELIVERED" },
      { marketplaceAccountId, marketplaceOrderId: "A3", orderedAt: new Date(), status: "DELIVERED" },
    ])
    .returning({ id: orders.id });
  orderIds = inserted.map((o) => o.id);
});

afterAll(async () => {
  await pool.end();
});

describe("payout reconciliation", () => {
  it("distributes a received amount proportionally across settlement lines, with no paise left unallocated", async () => {
    const { payoutBatchId } = await pullExpectedPayout({
      marketplaceAccountId,
      expectedDate: new Date(),
      orderTotals: [
        { orderId: orderIds[0], expectedAmount: "300.00" },
        { orderId: orderIds[1], expectedAmount: "200.00" },
        { orderId: orderIds[2], expectedAmount: "100.00" },
      ],
    });

    // Bank credited less than expected — a real shortfall to distribute.
    await confirmReceivedPayout({
      payoutBatchId,
      receivedAmount: "540.00",
      receivedDate: new Date(),
      bankReference: "UTR123456",
    });

    const lines = await db.select().from(settlementLines).where(sql`payout_batch_id = ${payoutBatchId}`);
    const total = lines.reduce((sum, l) => sum + Number(l.paidAmount), 0);

    expect(Math.round(total * 100) / 100).toBe(540);
    // Line proportional to 300/600 share of 540 = 270
    const line300 = lines.find((l) => l.expectedAmount === "300.00")!;
    expect(Number(line300.paidAmount)).toBeCloseTo(270, 1);
    expect(Number(line300.variance)).toBeCloseTo(-30, 1);
  });

  it("marks the batch RECONCILED when received matches expected exactly", async () => {
    const { payoutBatchId } = await pullExpectedPayout({
      marketplaceAccountId,
      expectedDate: new Date(),
      orderTotals: [{ orderId: orderIds[0], expectedAmount: "499.00" }],
    });
    await confirmReceivedPayout({ payoutBatchId, receivedAmount: "499.00", receivedDate: new Date(), bankReference: "UTR-EXACT" });

    const batchResult = await db.execute(sql`SELECT status FROM payout_batches WHERE id = ${payoutBatchId}`);
    expect((batchResult.rows[0] as any).status).toBe("RECONCILED");
  });
});
