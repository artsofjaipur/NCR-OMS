import {
  pgTable,
  pgEnum,
  serial,
  text,
  varchar,
  integer,
  numeric,
  boolean,
  timestamp,
  jsonb,
  uniqueIndex,
  index,
} from "drizzle-orm/pg-core";
import { relations, sql } from "drizzle-orm";

// ---------------------------------------------------------------------------
// Enums
// ---------------------------------------------------------------------------

export const userRoleEnum = pgEnum("user_role", ["OWNER", "ADMIN", "OPS", "VIEWER"]);

export const marketplaceEnum = pgEnum("marketplace", [
  "FLIPKART",
  "MEESHO",
  "SNAPDEAL",
  "AMAZON_IN",
  "AMAZON_COM",
  "MYNTRA",
  "AJIO",
]);

export const orderStatusEnum = pgEnum("order_status", [
  "CREATED",
  "READY_TO_DISPATCH",
  "DISPATCHED",
  "DELIVERED",
  "CANCELLED",
  "RTO_INITIATED",
  "ON_HOLD",
]);

export const fulfillmentTypeEnum = pgEnum("fulfillment_type", ["SELLER_FULFILLED", "MARKETPLACE_FULFILLED"]);

export const returnStatusEnum = pgEnum("return_status", [
  "INITIATED",
  "IN_TRANSIT",
  "RECEIVED",
  "QC_PASSED",
  "QC_FAILED",
  "RESTOCKED",
  "CLOSED",
]);

export const payoutStatusEnum = pgEnum("payout_status", ["EXPECTED", "PARTIALLY_RECEIVED", "RECONCILED", "DISPUTED"]);

export const purchaseSourceEnum = pgEnum("purchase_source", ["PURCHASE_ORDER", "DIRECT_ADJUSTMENT"]);

export const ledgerReasonEnum = pgEnum("ledger_reason", [
  "ORDER_RESERVED",
  "ORDER_CANCELLED",
  "DISPATCHED",
  "RETURN_RESTOCK",
  "PURCHASE_RECEIPT",
  "MANUAL_ADJUSTMENT",
]);

// ---------------------------------------------------------------------------
// Companies, Company Profile, Users, Audit
// ---------------------------------------------------------------------------

export const companies = pgTable("companies", {
  id: serial("id").primaryKey(),
  legalName: varchar("legal_name", { length: 200 }).notNull(),
  displayName: varchar("display_name", { length: 200 }).notNull(),
  logoUrl: text("logo_url"),
  gstin: varchar("gstin", { length: 15 }),
  pan: varchar("pan", { length: 10 }),
  cin: varchar("cin", { length: 21 }),
  addressLine1: varchar("address_line1", { length: 200 }),
  addressLine2: varchar("address_line2", { length: 200 }),
  city: varchar("city", { length: 100 }),
  state: varchar("state", { length: 100 }),
  stateCode: varchar("state_code", { length: 2 }),
  pincode: varchar("pincode", { length: 6 }),
  signatoryName: varchar("signatory_name", { length: 150 }),
  signatoryDesignation: varchar("signatory_designation", { length: 100 }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

// One company can hold more than one settlement bank account (per brand, or
// per GST-registration state) — kept as its own table rather than columns on
// `companies`, per the open question raised in the architecture addendum.
export const bankAccounts = pgTable("bank_accounts", {
  id: serial("id").primaryKey(),
  companyId: integer("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
  label: varchar("label", { length: 100 }).notNull(),
  accountHolderName: varchar("account_holder_name", { length: 150 }).notNull(),
  accountNumberEncrypted: text("account_number_encrypted").notNull(),
  ifsc: varchar("ifsc", { length: 11 }).notNull(),
  bankName: varchar("bank_name", { length: 150 }).notNull(),
  branchName: varchar("branch_name", { length: 150 }),
  accountType: varchar("account_type", { length: 30 }).default("CURRENT"),
  isPrimary: boolean("is_primary").notNull().default(false),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const users = pgTable(
  "users",
  {
    id: serial("id").primaryKey(),
    companyId: integer("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    email: varchar("email", { length: 255 }).notNull(),
    passwordHash: text("password_hash").notNull(),
    role: userRoleEnum("role").notNull().default("OPS"),
    displayName: varchar("display_name", { length: 150 }),
    isActive: boolean("is_active").notNull().default(true),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    emailPerCompanyUnique: uniqueIndex("users_company_email_uq").on(t.companyId, t.email),
  }),
);

export const auditLogs = pgTable(
  "audit_logs",
  {
    id: serial("id").primaryKey(),
    companyId: integer("company_id").notNull().references(() => companies.id),
    userId: integer("user_id").references(() => users.id),
    action: varchar("action", { length: 120 }).notNull(),
    entityType: varchar("entity_type", { length: 60 }).notNull(),
    entityId: varchar("entity_id", { length: 60 }),
    metadata: jsonb("metadata"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    companyCreatedIdx: index("audit_logs_company_created_idx").on(t.companyId, t.createdAt),
  }),
);

// ---------------------------------------------------------------------------
// Brands, Marketplace Accounts
// ---------------------------------------------------------------------------

export const brands = pgTable("brands", {
  id: serial("id").primaryKey(),
  companyId: integer("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
  name: varchar("name", { length: 150 }).notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const marketplaceAccounts = pgTable(
  "marketplace_accounts",
  {
    id: serial("id").primaryKey(),
    brandId: integer("brand_id").notNull().references(() => brands.id, { onDelete: "cascade" }),
    marketplace: marketplaceEnum("marketplace").notNull(),
    sellerAccountLabel: varchar("seller_account_label", { length: 150 }).notNull(),
    // AES-256-GCM envelope-encrypted credential blob for this seller account.
    credentialsEncrypted: text("credentials_encrypted").notNull(),
    payoutCycleDays: integer("payout_cycle_days"),
    isActive: boolean("is_active").notNull().default(true),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    brandMarketplaceUq: uniqueIndex("marketplace_accounts_brand_marketplace_uq").on(t.brandId, t.marketplace, t.sellerAccountLabel),
  }),
);

// ---------------------------------------------------------------------------
// SKU Master, Listings, Warehouses
// ---------------------------------------------------------------------------

export const skus = pgTable(
  "skus",
  {
    id: serial("id").primaryKey(),
    brandId: integer("brand_id").notNull().references(() => brands.id, { onDelete: "cascade" }),
    code: varchar("code", { length: 100 }).notNull(),
    productTitle: varchar("product_title", { length: 300 }).notNull(),
    color: varchar("color", { length: 60 }),
    size: varchar("size", { length: 20 }),
    hsnCode: varchar("hsn_code", { length: 10 }),
    mrp: numeric("mrp", { precision: 10, scale: 2 }),
    isActive: boolean("is_active").notNull().default(true),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    // SKU codes are only unique *within* a brand — the same code (e.g. "Svm-02")
    // is legitimately reused across different brands in the source catalogs.
    brandCodeUq: uniqueIndex("skus_brand_code_uq").on(t.brandId, t.code),
  }),
);

// Maps a marketplace's own (inconsistent) SKU/catalog string to a canonical
// SKU row, so ingestion never has to regex three different encodings live.
export const marketplaceSkuMap = pgTable(
  "marketplace_sku_map",
  {
    id: serial("id").primaryKey(),
    marketplaceAccountId: integer("marketplace_account_id").notNull().references(() => marketplaceAccounts.id, { onDelete: "cascade" }),
    marketplaceSku: varchar("marketplace_sku", { length: 200 }).notNull(),
    marketplaceCatalogId: varchar("marketplace_catalog_id", { length: 100 }),
    skuId: integer("sku_id").notNull().references(() => skus.id),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    accountSkuUq: uniqueIndex("marketplace_sku_map_account_sku_uq").on(t.marketplaceAccountId, t.marketplaceSku),
  }),
);

export const listings = pgTable(
  "listings",
  {
    id: serial("id").primaryKey(),
    marketplaceAccountId: integer("marketplace_account_id").notNull().references(() => marketplaceAccounts.id, { onDelete: "cascade" }),
    skuId: integer("sku_id").notNull().references(() => skus.id),
    marketplaceListingId: varchar("marketplace_listing_id", { length: 100 }).notNull(),
    isActive: boolean("is_active").notNull().default(true),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    accountListingUq: uniqueIndex("listings_account_listing_uq").on(t.marketplaceAccountId, t.marketplaceListingId),
  }),
);

export const warehouses = pgTable("warehouses", {
  id: serial("id").primaryKey(),
  companyId: integer("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
  name: varchar("name", { length: 150 }).notNull(),
  city: varchar("city", { length: 100 }),
  isDefault: boolean("is_default").notNull().default(false),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

// ---------------------------------------------------------------------------
// Inventory ledger — append-only, current stock = SUM(delta)
// ---------------------------------------------------------------------------

export const inventoryLedger = pgTable(
  "inventory_ledger",
  {
    id: serial("id").primaryKey(),
    skuId: integer("sku_id").notNull().references(() => skus.id),
    warehouseId: integer("warehouse_id").notNull().references(() => warehouses.id),
    delta: integer("delta").notNull(),
    reason: ledgerReasonEnum("reason").notNull(),
    referenceType: varchar("reference_type", { length: 40 }),
    referenceId: varchar("reference_id", { length: 60 }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    skuWarehouseIdx: index("inventory_ledger_sku_warehouse_idx").on(t.skuId, t.warehouseId),
  }),
);

// ---------------------------------------------------------------------------
// Orders, Order Items, Shipments, Returns
// ---------------------------------------------------------------------------

export const orders = pgTable(
  "orders",
  {
    id: serial("id").primaryKey(),
    marketplaceAccountId: integer("marketplace_account_id").notNull().references(() => marketplaceAccounts.id),
    marketplaceOrderId: varchar("marketplace_order_id", { length: 100 }).notNull(),
    status: orderStatusEnum("status").notNull().default("CREATED"),
    fulfillmentType: fulfillmentTypeEnum("fulfillment_type").notNull().default("SELLER_FULFILLED"),
    invoiceNumber: varchar("invoice_number", { length: 60 }),
    invoiceDate: timestamp("invoice_date", { withTimezone: true }),
    orderedAt: timestamp("ordered_at", { withTimezone: true }).notNull(),
    verifiedAt: timestamp("verified_at", { withTimezone: true }),
    holdReason: text("hold_reason"),
    holdDate: timestamp("hold_date", { withTimezone: true }),
    rawPayload: jsonb("raw_payload"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    accountOrderUq: uniqueIndex("orders_account_order_uq").on(t.marketplaceAccountId, t.marketplaceOrderId),
  }),
);

export const orderItems = pgTable(
  "order_items",
  {
    id: serial("id").primaryKey(),
    orderId: integer("order_id").notNull().references(() => orders.id, { onDelete: "cascade" }),
    marketplaceLineItemId: varchar("marketplace_line_item_id", { length: 100 }),
    skuId: integer("sku_id").references(() => skus.id),
    marketplaceSku: varchar("marketplace_sku", { length: 200 }).notNull(),
    productTitleSnapshot: varchar("product_title_snapshot", { length: 300 }).notNull(),
    variantSize: varchar("variant_size", { length: 20 }),
    quantity: integer("quantity").notNull(),
    unitPrice: numeric("unit_price", { precision: 10, scale: 2 }).notNull(),
    mrp: numeric("mrp", { precision: 10, scale: 2 }),
    shippingCharge: numeric("shipping_charge", { precision: 10, scale: 2 }).default("0"),
    invoiceAmount: numeric("invoice_amount", { precision: 10, scale: 2 }),
    taxCgst: numeric("tax_cgst", { precision: 10, scale: 2 }),
    taxSgst: numeric("tax_sgst", { precision: 10, scale: 2 }),
    taxIgst: numeric("tax_igst", { precision: 10, scale: 2 }),
    taxRate: numeric("tax_rate", { precision: 5, scale: 2 }),
    hsnCode: varchar("hsn_code", { length: 10 }),
    settlementPriceEstimate: numeric("settlement_price_estimate", { precision: 10, scale: 2 }),
  },
);

export const shipments = pgTable(
  "shipments",
  {
    id: serial("id").primaryKey(),
    orderId: integer("order_id").notNull().references(() => orders.id, { onDelete: "cascade" }),
    warehouseId: integer("warehouse_id").references(() => warehouses.id),
    marketplaceShipmentId: varchar("marketplace_shipment_id", { length: 120 }),
    packageId: varchar("package_id", { length: 100 }),
    packetId: varchar("packet_id", { length: 100 }),
    awbNumber: varchar("awb_number", { length: 100 }),
    carrier: varchar("carrier", { length: 100 }),
    trackingUrl: text("tracking_url"),
    serviceLevel: varchar("service_level", { length: 30 }),
    recipientName: varchar("recipient_name", { length: 150 }),
    recipientAddressLine1: varchar("recipient_address_line1", { length: 250 }),
    recipientAddressLine2: varchar("recipient_address_line2", { length: 250 }),
    recipientCity: varchar("recipient_city", { length: 100 }),
    recipientState: varchar("recipient_state", { length: 100 }),
    recipientPincode: varchar("recipient_pincode", { length: 6 }),
    dispatchWindowStart: timestamp("dispatch_window_start", { withTimezone: true }),
    dispatchWindowEnd: timestamp("dispatch_window_end", { withTimezone: true }),
    packedAt: timestamp("packed_at", { withTimezone: true }),
    shippedAt: timestamp("shipped_at", { withTimezone: true }),
    deliveredAt: timestamp("delivered_at", { withTimezone: true }),
    packageLengthCm: numeric("package_length_cm", { precision: 6, scale: 2 }),
    packageBreadthCm: numeric("package_breadth_cm", { precision: 6, scale: 2 }),
    packageHeightCm: numeric("package_height_cm", { precision: 6, scale: 2 }),
    packageWeightKg: numeric("package_weight_kg", { precision: 6, scale: 3 }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
);

export const returns = pgTable("returns", {
  id: serial("id").primaryKey(),
  orderId: integer("order_id").notNull().references(() => orders.id, { onDelete: "cascade" }),
  orderItemId: integer("order_item_id").references(() => orderItems.id),
  status: returnStatusEnum("status").notNull().default("INITIATED"),
  reverseAwb: varchar("reverse_awb", { length: 100 }),
  reverseCarrier: varchar("reverse_carrier", { length: 100 }),
  initiatedAt: timestamp("initiated_at", { withTimezone: true }),
  deliveredAt: timestamp("delivered_at", { withTimezone: true }),
  qcNotes: text("qc_notes"),
  restockedAt: timestamp("restocked_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

// ---------------------------------------------------------------------------
// Payout tracking, Settlement, Cost, Expense
// ---------------------------------------------------------------------------

export const payoutBatches = pgTable("payout_batches", {
  id: serial("id").primaryKey(),
  marketplaceAccountId: integer("marketplace_account_id").notNull().references(() => marketplaceAccounts.id),
  expectedDate: timestamp("expected_date", { withTimezone: true }).notNull(),
  expectedAmount: numeric("expected_amount", { precision: 12, scale: 2 }).notNull(),
  receivedDate: timestamp("received_date", { withTimezone: true }),
  receivedAmount: numeric("received_amount", { precision: 12, scale: 2 }),
  bankReference: varchar("bank_reference", { length: 100 }),
  status: payoutStatusEnum("status").notNull().default("EXPECTED"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const settlementLines = pgTable("settlement_lines", {
  id: serial("id").primaryKey(),
  payoutBatchId: integer("payout_batch_id").notNull().references(() => payoutBatches.id, { onDelete: "cascade" }),
  orderId: integer("order_id").notNull().references(() => orders.id),
  expectedAmount: numeric("expected_amount", { precision: 12, scale: 2 }).notNull(),
  paidAmount: numeric("paid_amount", { precision: 12, scale: 2 }),
  variance: numeric("variance", { precision: 12, scale: 2 }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const costEntries = pgTable("cost_entries", {
  id: serial("id").primaryKey(),
  skuId: integer("sku_id").notNull().references(() => skus.id),
  unitCost: numeric("unit_cost", { precision: 10, scale: 2 }).notNull(),
  effectiveFrom: timestamp("effective_from", { withTimezone: true }).notNull(),
  effectiveTo: timestamp("effective_to", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const expenses = pgTable("expenses", {
  id: serial("id").primaryKey(),
  brandId: integer("brand_id").notNull().references(() => brands.id),
  category: varchar("category", { length: 80 }).notNull(),
  amount: numeric("amount", { precision: 12, scale: 2 }).notNull(),
  periodStart: timestamp("period_start", { withTimezone: true }).notNull(),
  periodEnd: timestamp("period_end", { withTimezone: true }).notNull(),
  notes: text("notes"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

// ---------------------------------------------------------------------------
// Purchase Entry & Direct Stock Update, Supplier Master
// ---------------------------------------------------------------------------

// Raw-material / manufacturing vendor — deliberately a separate entity from
// "brand", even though the supplier-manifest PDFs label the brand field
// "Supplier Name". Conflating the two was flagged as a naming trap.
export const suppliers = pgTable("suppliers", {
  id: serial("id").primaryKey(),
  companyId: integer("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
  name: varchar("name", { length: 150 }).notNull(),
  gstin: varchar("gstin", { length: 15 }),
  contactPhone: varchar("contact_phone", { length: 20 }),
  contactEmail: varchar("contact_email", { length: 255 }),
  addressLine1: varchar("address_line1", { length: 250 }),
  city: varchar("city", { length: 100 }),
  state: varchar("state", { length: 100 }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const purchaseEntries = pgTable("purchase_entries", {
  id: serial("id").primaryKey(),
  companyId: integer("company_id").notNull().references(() => companies.id),
  warehouseId: integer("warehouse_id").notNull().references(() => warehouses.id),
  supplierId: integer("supplier_id").references(() => suppliers.id),
  source: purchaseSourceEnum("source").notNull().default("PURCHASE_ORDER"),
  poReference: varchar("po_reference", { length: 100 }),
  supplierInvoiceNumber: varchar("supplier_invoice_number", { length: 100 }),
  invoiceDate: timestamp("invoice_date", { withTimezone: true }),
  adjustmentReason: text("adjustment_reason"),
  createdByUserId: integer("created_by_user_id").references(() => users.id),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const purchaseEntryItems = pgTable("purchase_entry_items", {
  id: serial("id").primaryKey(),
  purchaseEntryId: integer("purchase_entry_id").notNull().references(() => purchaseEntries.id, { onDelete: "cascade" }),
  skuId: integer("sku_id").notNull().references(() => skus.id),
  quantity: integer("quantity").notNull(),
  unitCost: numeric("unit_cost", { precision: 10, scale: 2 }).notNull(),
});

// ---------------------------------------------------------------------------
// Relations (for query ergonomics; not required for raw SQL correctness)
// ---------------------------------------------------------------------------

export const companiesRelations = relations(companies, ({ many }) => ({
  users: many(users),
  brands: many(brands),
  warehouses: many(warehouses),
  bankAccounts: many(bankAccounts),
  suppliers: many(suppliers),
}));

export const brandsRelations = relations(brands, ({ one, many }) => ({
  company: one(companies, { fields: [brands.companyId], references: [companies.id] }),
  marketplaceAccounts: many(marketplaceAccounts),
  skus: many(skus),
}));

export const ordersRelations = relations(orders, ({ one, many }) => ({
  marketplaceAccount: one(marketplaceAccounts, { fields: [orders.marketplaceAccountId], references: [marketplaceAccounts.id] }),
  items: many(orderItems),
  shipments: many(shipments),
}));

export const orderItemsRelations = relations(orderItems, ({ one }) => ({
  order: one(orders, { fields: [orderItems.orderId], references: [orders.id] }),
  sku: one(skus, { fields: [orderItems.skuId], references: [skus.id] }),
}));

export const payoutBatchesRelations = relations(payoutBatches, ({ many }) => ({
  settlementLines: many(settlementLines),
}));
