/**
 * End-to-end smoke test: seeds a company/brand/warehouse/marketplace
 * account, imports a real Flipkart order CSV over HTTP, and checks it
 * produced a reserved-stock order plus a correct Daily Dispatch picklist.
 *
 * DESTRUCTIVE — truncates core tables first. Only ever run this against a
 * disposable/dev database, never against production data.
 *   DATABASE_URL="<dev-db-url>" npx tsx scripts/smoke.ts
 */
import "dotenv/config";
import { sql } from "drizzle-orm";
import { db, pool } from "../src/db/client";
import { companies, users, brands, warehouses, marketplaceAccounts, skus, marketplaceSkuMap, inventoryLedger } from "../src/db/schema";
import { hashPassword } from "../src/security/password";
import { encryptJson } from "../src/security/crypto";
import { createApp } from "../src/app";
import http from "http";

async function main() {
  await db.execute(
    sql`TRUNCATE TABLE inventory_ledger, marketplace_sku_map, listings, skus, marketplace_accounts, warehouses, users, brands, companies RESTART IDENTITY CASCADE`,
  );

  const [company] = await db.insert(companies).values({ legalName: "Nyko Mart Pvt Ltd", displayName: "Nyko Mart" }).returning({ id: companies.id });
  const [brand] = await db.insert(brands).values({ companyId: company.id, name: "Vardhamati" }).returning({ id: brands.id });
  const [warehouse] = await db.insert(warehouses).values({ companyId: company.id, name: "Main WH", isDefault: true }).returning({ id: warehouses.id });
  const [account] = await db
    .insert(marketplaceAccounts)
    .values({ brandId: brand.id, marketplace: "FLIPKART", sellerAccountLabel: "Smoke Seller", credentialsEncrypted: encryptJson({ token: "x" }) })
    .returning({ id: marketplaceAccounts.id });
  const [sku] = await db
    .insert(skus)
    .values({ brandId: brand.id, code: "SVM-02-Purple night set Dress-XL", productTitle: "Purple Two Piece Dress", size: "XL" })
    .returning({ id: skus.id });
  await db.insert(marketplaceSkuMap).values({ marketplaceAccountId: account.id, marketplaceSku: "SVM-02-Purple night set Dress-XL", skuId: sku.id });
  await db.insert(inventoryLedger).values({ skuId: sku.id, warehouseId: warehouse.id, delta: 10, reason: "PURCHASE_RECEIPT", referenceType: "smoke", referenceId: "1" });

  const passwordHash = await hashPassword("smoke-test-pass");
  await db.insert(users).values({ companyId: company.id, email: "owner@nykomart.test", passwordHash, role: "OWNER" });

  const app = createApp();
  const server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(4321, resolve));

  const base = "http://localhost:4321";
  const fetchJson = async (path: string, init?: any) => {
    const res = await fetch(base + path, init);
    const text = await res.text();
    return { status: res.status, body: text ? JSON.parse(text) : null };
  };

  const health = await fetchJson("/health");
  console.log("HEALTH", health.status, health.body);

  const login = await fetchJson("/auth/login", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ companyId: company.id, email: "owner@nykomart.test", password: "smoke-test-pass" }),
  });
  console.log("LOGIN", login.status);
  const token = login.body.token;

  const flipkartCsv = `Ordered On,Shipment ID,ORDER ITEM ID,Order Id,HSN CODE,Order State,Order Type,FSN,SKU,Product,Invoice No.,CGST,IGST,SGST,Invoice Date (mm/dd/yy),Invoice Amount,Selling Price Per Item,Shipping and Handling Charges,Quantity,Price inc. FKMP Contribution & Subsidy,Buyer name,Ship to name,Address Line 1,Address Line 2,City,State,PIN Code,Dispatch After date,Dispatch by date,Form requirement,Tracking ID,Package Length (cm),Package Breadth (cm),Package Height (cm),Package Weight (kg),Ready to Make,With Attachment
"Aug 26, 2026",0b7bffa9-2130-4ccf-9e18-728e36bb5237,'438462135749739102,OD438462135749739100,6211,Ready to dispatch,NON_FBF,DREHZHPVMRRAZYMH,SVM-02-Purple night set Dress-XL,Vardhamiti Women Two Piece Dress Purple Ankle Length Dress XL SVM-02-Purple night set Dress,LWADHI7270000164,NA,5,NA,08/26/26,428,313,0,1,428,Richa Budholiya,Richa Budholiya,"Flat - 714, Swaraaj Heights, near 18 Latitude Mall, Punawale","Kate Wasti, Punawale, Pimpri-Chinchwad",Pune,Maharashtra,411033,"Aug 26, 2026 23:16:23","Aug 27, 2026 12:00:00",,FMPP4241805152,8,4,2,0.2,NO,NO
`;

  const importResult = await fetchJson("/orders/import/flipkart", {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
    body: JSON.stringify({ marketplaceAccountId: account.id, warehouseId: warehouse.id, csv: flipkartCsv }),
  });
  console.log("IMPORT", importResult.status, JSON.stringify(importResult.body));

  const ordersList = await fetchJson("/orders", { headers: { authorization: `Bearer ${token}` } });
  console.log("ORDERS", ordersList.status, ordersList.body.length, "order(s) —", ordersList.body[0]?.marketplaceOrderId, ordersList.body[0]?.status);

  const picklist = await fetchJson(`/dispatch/picklist/${brand.id}`, { headers: { authorization: `Bearer ${token}` } });
  console.log("PICKLIST", picklist.status, JSON.stringify(picklist.body));

  const packingSheets = await fetchJson(`/dispatch/packing-sheets/${brand.id}`, { headers: { authorization: `Bearer ${token}` } });
  console.log("PACKING SHEETS", packingSheets.status, JSON.stringify(packingSheets.body));

  const noAuth = await fetchJson("/orders");
  console.log("NO AUTH BLOCKED?", noAuth.status === 401 ? "yes (401)" : `NO — got ${noAuth.status}`);

  server.close();
  await pool.end();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
