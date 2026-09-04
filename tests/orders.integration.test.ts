import { describe, it, expect, beforeAll, beforeEach, afterAll } from "vitest";
import { execSync } from "child_process";
import "dotenv/config";
import { db, pool } from "../src/db/client";
import { companies, brands, warehouses, marketplaceAccounts, skus, marketplaceSkuMap } from "../src/db/schema";
import { ingestOrder, UnmappedSkuError } from "../src/modules/orders/ingest";
import { InsufficientStockError, getCurrentStock } from "../src/modules/inventory/ledger";
import { NormalizedOrder } from "../src/ingestion/types";
import { sql } from "drizzle-orm";

// These exercise real Postgres semantics (transactions, advisory locks) —
// they need DATABASE_URL pointed at an actual Postgres, not a mock.

let companyId: number;
let brandId: number;
let warehouseId: number;
let marketplaceAccountId: number;
let skuId: number;

function makeOrder(overrides: Partial<NormalizedOrder> = {}, marketplaceSku = "TEST-SKU-M", quantity = 1): NormalizedOrder {
  return {
    marketplaceOrderId: `ORDER-${Math.random().toString(36).slice(2, 10)}`,
    status: "READY_TO_DISPATCH",
    fulfillmentType: "SELLER_FULFILLED",
    orderedAt: new Date(),
    items: [
      {
        marketplaceSku,
        productTitleSnapshot: "Test Product",
        quantity,
        unitPrice: "499.00",
        invoiceAmount: "499.00",
      },
    ],
    rawPayload: { test: true },
    ...overrides,
  };
}

beforeAll(async () => {
  execSync("npx drizzle-kit push --force", { stdio: "inherit", cwd: process.cwd() });
});

beforeEach(async () => {
  await db.execute(sql`TRUNCATE TABLE
    settlement_lines, payout_batches, returns, shipments, order_items, orders,
    marketplace_sku_map, listings, inventory_ledger, purchase_entry_items, purchase_entries,
    skus, marketplace_accounts, warehouses, suppliers, brands, bank_accounts, users, audit_logs, companies,
    cost_entries, expenses
    RESTART IDENTITY CASCADE`);

  const [company] = await db.insert(companies).values({ legalName: "Nyko Mart Pvt Ltd", displayName: "Nyko Mart" }).returning({ id: companies.id });
  companyId = company.id;

  const [brand] = await db.insert(brands).values({ companyId, name: "Vardhamati" }).returning({ id: brands.id });
  brandId = brand.id;

  const [warehouse] = await db.insert(warehouses).values({ companyId, name: "Main WH", isDefault: true }).returning({ id: warehouses.id });
  warehouseId = warehouse.id;

  const [account] = await db
    .insert(marketplaceAccounts)
    .values({ brandId, marketplace: "FLIPKART", sellerAccountLabel: "Test Seller", credentialsEncrypted: "unused-in-tests" })
    .returning({ id: marketplaceAccounts.id });
  marketplaceAccountId = account.id;

  const [sku] = await db
    .insert(skus)
    .values({ brandId, code: "TEST-SKU", productTitle: "Test Product", size: "M" })
    .returning({ id: skus.id });
  skuId = sku.id;

  await db.insert(marketplaceSkuMap).values({ marketplaceAccountId, marketplaceSku: "TEST-SKU-M", skuId });
});

afterAll(async () => {
  await pool.end();
});

describe("order ingestion — atomicity", () => {
  it("rolls back the whole order when a line item has insufficient stock", async () => {
    // Zero stock in the ledger for this SKU/warehouse.
    await expect(ingestOrder(marketplaceAccountId, warehouseId, makeOrder())).rejects.toBeInstanceOf(InsufficientStockError);

    const orderCountResult = await db.execute(sql`SELECT count(*)::int AS count FROM orders`);
    expect((orderCountResult.rows[0] as any).count).toBe(0);
    const itemCountResult = await db.execute(sql`SELECT count(*)::int AS count FROM order_items`);
    expect((itemCountResult.rows[0] as any).count).toBe(0);
  });

  it("commits the order and the stock reservation together once stock exists", async () => {
    await db.insert((await import("../src/db/schema")).inventoryLedger).values({
      skuId,
      warehouseId,
      delta: 5,
      reason: "PURCHASE_RECEIPT",
      referenceType: "test-seed",
      referenceId: "seed-1",
    });

    const result = await ingestOrder(marketplaceAccountId, warehouseId, makeOrder());
    expect(result.created).toBe(true);

    const stock = await db.transaction(async (tx) => getCurrentStock(tx, skuId, warehouseId));
    expect(stock).toBe(4); // 5 received - 1 reserved
  });

  it("throws UnmappedSkuError for a SKU with no mapping, and does not partially ingest", async () => {
    await expect(ingestOrder(marketplaceAccountId, warehouseId, makeOrder({}, "NOT-MAPPED-SKU"))).rejects.toBeInstanceOf(UnmappedSkuError);
    const orderCountResult = await db.execute(sql`SELECT count(*)::int AS count FROM orders`);
    expect((orderCountResult.rows[0] as any).count).toBe(0);
  });

  it("is idempotent — re-ingesting the same marketplace order id does not double-reserve stock", async () => {
    await db.insert((await import("../src/db/schema")).inventoryLedger).values({
      skuId,
      warehouseId,
      delta: 5,
      reason: "PURCHASE_RECEIPT",
      referenceType: "test-seed",
      referenceId: "seed-2",
    });

    const order = makeOrder();
    const first = await ingestOrder(marketplaceAccountId, warehouseId, order);
    const second = await ingestOrder(marketplaceAccountId, warehouseId, order);

    expect(first.created).toBe(true);
    expect(second.created).toBe(false);
    expect(second.orderId).toBe(first.orderId);

    const stock = await db.transaction(async (tx) => getCurrentStock(tx, skuId, warehouseId));
    expect(stock).toBe(4); // only reserved once, not twice
  });

  it("never oversells — a second order for more than remaining stock is rejected, first order's reservation stands", async () => {
    await db.insert((await import("../src/db/schema")).inventoryLedger).values({
      skuId,
      warehouseId,
      delta: 2,
      reason: "PURCHASE_RECEIPT",
      referenceType: "test-seed",
      referenceId: "seed-3",
    });

    await ingestOrder(marketplaceAccountId, warehouseId, makeOrder({}, "TEST-SKU-M", 2));
    await expect(ingestOrder(marketplaceAccountId, warehouseId, makeOrder({}, "TEST-SKU-M", 1))).rejects.toBeInstanceOf(
      InsufficientStockError,
    );

    const stock = await db.transaction(async (tx) => getCurrentStock(tx, skuId, warehouseId));
    expect(stock).toBe(0);
  });
});
