CREATE TYPE "public"."fulfillment_type" AS ENUM('SELLER_FULFILLED', 'MARKETPLACE_FULFILLED');--> statement-breakpoint
CREATE TYPE "public"."ledger_reason" AS ENUM('ORDER_RESERVED', 'ORDER_CANCELLED', 'DISPATCHED', 'RETURN_RESTOCK', 'PURCHASE_RECEIPT', 'MANUAL_ADJUSTMENT');--> statement-breakpoint
CREATE TYPE "public"."marketplace" AS ENUM('FLIPKART', 'MEESHO', 'SNAPDEAL', 'AMAZON_IN', 'AMAZON_COM', 'MYNTRA', 'AJIO');--> statement-breakpoint
CREATE TYPE "public"."order_status" AS ENUM('CREATED', 'READY_TO_DISPATCH', 'DISPATCHED', 'DELIVERED', 'CANCELLED', 'RTO_INITIATED', 'ON_HOLD');--> statement-breakpoint
CREATE TYPE "public"."payout_status" AS ENUM('EXPECTED', 'PARTIALLY_RECEIVED', 'RECONCILED', 'DISPUTED');--> statement-breakpoint
CREATE TYPE "public"."purchase_source" AS ENUM('PURCHASE_ORDER', 'DIRECT_ADJUSTMENT');--> statement-breakpoint
CREATE TYPE "public"."return_status" AS ENUM('INITIATED', 'IN_TRANSIT', 'RECEIVED', 'QC_PASSED', 'QC_FAILED', 'RESTOCKED', 'CLOSED');--> statement-breakpoint
CREATE TYPE "public"."user_role" AS ENUM('OWNER', 'ADMIN', 'OPS', 'VIEWER');--> statement-breakpoint
CREATE TABLE "audit_logs" (
	"id" serial PRIMARY KEY NOT NULL,
	"company_id" integer NOT NULL,
	"user_id" integer,
	"action" varchar(120) NOT NULL,
	"entity_type" varchar(60) NOT NULL,
	"entity_id" varchar(60),
	"metadata" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "bank_accounts" (
	"id" serial PRIMARY KEY NOT NULL,
	"company_id" integer NOT NULL,
	"label" varchar(100) NOT NULL,
	"account_holder_name" varchar(150) NOT NULL,
	"account_number_encrypted" text NOT NULL,
	"ifsc" varchar(11) NOT NULL,
	"bank_name" varchar(150) NOT NULL,
	"branch_name" varchar(150),
	"account_type" varchar(30) DEFAULT 'CURRENT',
	"is_primary" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "brands" (
	"id" serial PRIMARY KEY NOT NULL,
	"company_id" integer NOT NULL,
	"name" varchar(150) NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "companies" (
	"id" serial PRIMARY KEY NOT NULL,
	"legal_name" varchar(200) NOT NULL,
	"display_name" varchar(200) NOT NULL,
	"logo_url" text,
	"gstin" varchar(15),
	"pan" varchar(10),
	"cin" varchar(21),
	"address_line1" varchar(200),
	"address_line2" varchar(200),
	"city" varchar(100),
	"state" varchar(100),
	"state_code" varchar(2),
	"pincode" varchar(6),
	"signatory_name" varchar(150),
	"signatory_designation" varchar(100),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "cost_entries" (
	"id" serial PRIMARY KEY NOT NULL,
	"sku_id" integer NOT NULL,
	"unit_cost" numeric(10, 2) NOT NULL,
	"effective_from" timestamp with time zone NOT NULL,
	"effective_to" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "expenses" (
	"id" serial PRIMARY KEY NOT NULL,
	"brand_id" integer NOT NULL,
	"category" varchar(80) NOT NULL,
	"amount" numeric(12, 2) NOT NULL,
	"period_start" timestamp with time zone NOT NULL,
	"period_end" timestamp with time zone NOT NULL,
	"notes" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "inventory_ledger" (
	"id" serial PRIMARY KEY NOT NULL,
	"sku_id" integer NOT NULL,
	"warehouse_id" integer NOT NULL,
	"delta" integer NOT NULL,
	"reason" "ledger_reason" NOT NULL,
	"reference_type" varchar(40),
	"reference_id" varchar(60),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "listings" (
	"id" serial PRIMARY KEY NOT NULL,
	"marketplace_account_id" integer NOT NULL,
	"sku_id" integer NOT NULL,
	"marketplace_listing_id" varchar(100) NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "marketplace_accounts" (
	"id" serial PRIMARY KEY NOT NULL,
	"brand_id" integer NOT NULL,
	"marketplace" "marketplace" NOT NULL,
	"seller_account_label" varchar(150) NOT NULL,
	"credentials_encrypted" text NOT NULL,
	"payout_cycle_days" integer,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "marketplace_sku_map" (
	"id" serial PRIMARY KEY NOT NULL,
	"marketplace_account_id" integer NOT NULL,
	"marketplace_sku" varchar(200) NOT NULL,
	"marketplace_catalog_id" varchar(100),
	"sku_id" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "order_items" (
	"id" serial PRIMARY KEY NOT NULL,
	"order_id" integer NOT NULL,
	"marketplace_line_item_id" varchar(100),
	"sku_id" integer,
	"marketplace_sku" varchar(200) NOT NULL,
	"product_title_snapshot" varchar(300) NOT NULL,
	"variant_size" varchar(20),
	"quantity" integer NOT NULL,
	"unit_price" numeric(10, 2) NOT NULL,
	"mrp" numeric(10, 2),
	"shipping_charge" numeric(10, 2) DEFAULT '0',
	"invoice_amount" numeric(10, 2),
	"tax_cgst" numeric(10, 2),
	"tax_sgst" numeric(10, 2),
	"tax_igst" numeric(10, 2),
	"tax_rate" numeric(5, 2),
	"hsn_code" varchar(10),
	"settlement_price_estimate" numeric(10, 2)
);
--> statement-breakpoint
CREATE TABLE "orders" (
	"id" serial PRIMARY KEY NOT NULL,
	"marketplace_account_id" integer NOT NULL,
	"marketplace_order_id" varchar(100) NOT NULL,
	"status" "order_status" DEFAULT 'CREATED' NOT NULL,
	"fulfillment_type" "fulfillment_type" DEFAULT 'SELLER_FULFILLED' NOT NULL,
	"invoice_number" varchar(60),
	"invoice_date" timestamp with time zone,
	"ordered_at" timestamp with time zone NOT NULL,
	"verified_at" timestamp with time zone,
	"hold_reason" text,
	"hold_date" timestamp with time zone,
	"raw_payload" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "payout_batches" (
	"id" serial PRIMARY KEY NOT NULL,
	"marketplace_account_id" integer NOT NULL,
	"expected_date" timestamp with time zone NOT NULL,
	"expected_amount" numeric(12, 2) NOT NULL,
	"received_date" timestamp with time zone,
	"received_amount" numeric(12, 2),
	"bank_reference" varchar(100),
	"status" "payout_status" DEFAULT 'EXPECTED' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "purchase_entries" (
	"id" serial PRIMARY KEY NOT NULL,
	"company_id" integer NOT NULL,
	"warehouse_id" integer NOT NULL,
	"supplier_id" integer,
	"source" "purchase_source" DEFAULT 'PURCHASE_ORDER' NOT NULL,
	"po_reference" varchar(100),
	"supplier_invoice_number" varchar(100),
	"invoice_date" timestamp with time zone,
	"adjustment_reason" text,
	"created_by_user_id" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "purchase_entry_items" (
	"id" serial PRIMARY KEY NOT NULL,
	"purchase_entry_id" integer NOT NULL,
	"sku_id" integer NOT NULL,
	"quantity" integer NOT NULL,
	"unit_cost" numeric(10, 2) NOT NULL
);
--> statement-breakpoint
CREATE TABLE "returns" (
	"id" serial PRIMARY KEY NOT NULL,
	"order_id" integer NOT NULL,
	"order_item_id" integer,
	"status" "return_status" DEFAULT 'INITIATED' NOT NULL,
	"reverse_awb" varchar(100),
	"reverse_carrier" varchar(100),
	"initiated_at" timestamp with time zone,
	"delivered_at" timestamp with time zone,
	"qc_notes" text,
	"restocked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "settlement_lines" (
	"id" serial PRIMARY KEY NOT NULL,
	"payout_batch_id" integer NOT NULL,
	"order_id" integer NOT NULL,
	"expected_amount" numeric(12, 2) NOT NULL,
	"paid_amount" numeric(12, 2),
	"variance" numeric(12, 2),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "shipments" (
	"id" serial PRIMARY KEY NOT NULL,
	"order_id" integer NOT NULL,
	"warehouse_id" integer,
	"marketplace_shipment_id" varchar(120),
	"package_id" varchar(100),
	"packet_id" varchar(100),
	"awb_number" varchar(100),
	"carrier" varchar(100),
	"tracking_url" text,
	"service_level" varchar(30),
	"recipient_name" varchar(150),
	"recipient_address_line1" varchar(250),
	"recipient_address_line2" varchar(250),
	"recipient_city" varchar(100),
	"recipient_state" varchar(100),
	"recipient_pincode" varchar(6),
	"dispatch_window_start" timestamp with time zone,
	"dispatch_window_end" timestamp with time zone,
	"packed_at" timestamp with time zone,
	"shipped_at" timestamp with time zone,
	"delivered_at" timestamp with time zone,
	"package_length_cm" numeric(6, 2),
	"package_breadth_cm" numeric(6, 2),
	"package_height_cm" numeric(6, 2),
	"package_weight_kg" numeric(6, 3),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "skus" (
	"id" serial PRIMARY KEY NOT NULL,
	"brand_id" integer NOT NULL,
	"code" varchar(100) NOT NULL,
	"product_title" varchar(300) NOT NULL,
	"color" varchar(60),
	"size" varchar(20),
	"hsn_code" varchar(10),
	"mrp" numeric(10, 2),
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "suppliers" (
	"id" serial PRIMARY KEY NOT NULL,
	"company_id" integer NOT NULL,
	"name" varchar(150) NOT NULL,
	"gstin" varchar(15),
	"contact_phone" varchar(20),
	"contact_email" varchar(255),
	"address_line1" varchar(250),
	"city" varchar(100),
	"state" varchar(100),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" serial PRIMARY KEY NOT NULL,
	"company_id" integer NOT NULL,
	"email" varchar(255) NOT NULL,
	"password_hash" text NOT NULL,
	"role" "user_role" DEFAULT 'OPS' NOT NULL,
	"display_name" varchar(150),
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "warehouses" (
	"id" serial PRIMARY KEY NOT NULL,
	"company_id" integer NOT NULL,
	"name" varchar(150) NOT NULL,
	"city" varchar(100),
	"is_default" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "audit_logs" ADD CONSTRAINT "audit_logs_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "audit_logs" ADD CONSTRAINT "audit_logs_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bank_accounts" ADD CONSTRAINT "bank_accounts_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "brands" ADD CONSTRAINT "brands_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cost_entries" ADD CONSTRAINT "cost_entries_sku_id_skus_id_fk" FOREIGN KEY ("sku_id") REFERENCES "public"."skus"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "expenses" ADD CONSTRAINT "expenses_brand_id_brands_id_fk" FOREIGN KEY ("brand_id") REFERENCES "public"."brands"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inventory_ledger" ADD CONSTRAINT "inventory_ledger_sku_id_skus_id_fk" FOREIGN KEY ("sku_id") REFERENCES "public"."skus"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inventory_ledger" ADD CONSTRAINT "inventory_ledger_warehouse_id_warehouses_id_fk" FOREIGN KEY ("warehouse_id") REFERENCES "public"."warehouses"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "listings" ADD CONSTRAINT "listings_marketplace_account_id_marketplace_accounts_id_fk" FOREIGN KEY ("marketplace_account_id") REFERENCES "public"."marketplace_accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "listings" ADD CONSTRAINT "listings_sku_id_skus_id_fk" FOREIGN KEY ("sku_id") REFERENCES "public"."skus"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "marketplace_accounts" ADD CONSTRAINT "marketplace_accounts_brand_id_brands_id_fk" FOREIGN KEY ("brand_id") REFERENCES "public"."brands"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "marketplace_sku_map" ADD CONSTRAINT "marketplace_sku_map_marketplace_account_id_marketplace_accounts_id_fk" FOREIGN KEY ("marketplace_account_id") REFERENCES "public"."marketplace_accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "marketplace_sku_map" ADD CONSTRAINT "marketplace_sku_map_sku_id_skus_id_fk" FOREIGN KEY ("sku_id") REFERENCES "public"."skus"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "order_items" ADD CONSTRAINT "order_items_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "order_items" ADD CONSTRAINT "order_items_sku_id_skus_id_fk" FOREIGN KEY ("sku_id") REFERENCES "public"."skus"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "orders" ADD CONSTRAINT "orders_marketplace_account_id_marketplace_accounts_id_fk" FOREIGN KEY ("marketplace_account_id") REFERENCES "public"."marketplace_accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payout_batches" ADD CONSTRAINT "payout_batches_marketplace_account_id_marketplace_accounts_id_fk" FOREIGN KEY ("marketplace_account_id") REFERENCES "public"."marketplace_accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "purchase_entries" ADD CONSTRAINT "purchase_entries_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "purchase_entries" ADD CONSTRAINT "purchase_entries_warehouse_id_warehouses_id_fk" FOREIGN KEY ("warehouse_id") REFERENCES "public"."warehouses"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "purchase_entries" ADD CONSTRAINT "purchase_entries_supplier_id_suppliers_id_fk" FOREIGN KEY ("supplier_id") REFERENCES "public"."suppliers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "purchase_entries" ADD CONSTRAINT "purchase_entries_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "purchase_entry_items" ADD CONSTRAINT "purchase_entry_items_purchase_entry_id_purchase_entries_id_fk" FOREIGN KEY ("purchase_entry_id") REFERENCES "public"."purchase_entries"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "purchase_entry_items" ADD CONSTRAINT "purchase_entry_items_sku_id_skus_id_fk" FOREIGN KEY ("sku_id") REFERENCES "public"."skus"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "returns" ADD CONSTRAINT "returns_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "returns" ADD CONSTRAINT "returns_order_item_id_order_items_id_fk" FOREIGN KEY ("order_item_id") REFERENCES "public"."order_items"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "settlement_lines" ADD CONSTRAINT "settlement_lines_payout_batch_id_payout_batches_id_fk" FOREIGN KEY ("payout_batch_id") REFERENCES "public"."payout_batches"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "settlement_lines" ADD CONSTRAINT "settlement_lines_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shipments" ADD CONSTRAINT "shipments_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shipments" ADD CONSTRAINT "shipments_warehouse_id_warehouses_id_fk" FOREIGN KEY ("warehouse_id") REFERENCES "public"."warehouses"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "skus" ADD CONSTRAINT "skus_brand_id_brands_id_fk" FOREIGN KEY ("brand_id") REFERENCES "public"."brands"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "suppliers" ADD CONSTRAINT "suppliers_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "users" ADD CONSTRAINT "users_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "warehouses" ADD CONSTRAINT "warehouses_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "audit_logs_company_created_idx" ON "audit_logs" USING btree ("company_id","created_at");--> statement-breakpoint
CREATE INDEX "inventory_ledger_sku_warehouse_idx" ON "inventory_ledger" USING btree ("sku_id","warehouse_id");--> statement-breakpoint
CREATE UNIQUE INDEX "listings_account_listing_uq" ON "listings" USING btree ("marketplace_account_id","marketplace_listing_id");--> statement-breakpoint
CREATE UNIQUE INDEX "marketplace_accounts_brand_marketplace_uq" ON "marketplace_accounts" USING btree ("brand_id","marketplace","seller_account_label");--> statement-breakpoint
CREATE UNIQUE INDEX "marketplace_sku_map_account_sku_uq" ON "marketplace_sku_map" USING btree ("marketplace_account_id","marketplace_sku");--> statement-breakpoint
CREATE UNIQUE INDEX "orders_account_order_uq" ON "orders" USING btree ("marketplace_account_id","marketplace_order_id");--> statement-breakpoint
CREATE UNIQUE INDEX "skus_brand_code_uq" ON "skus" USING btree ("brand_id","code");--> statement-breakpoint
CREATE UNIQUE INDEX "users_company_email_uq" ON "users" USING btree ("company_id","email");