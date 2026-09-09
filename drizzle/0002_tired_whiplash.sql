CREATE TABLE "credit_notes" (
	"id" serial PRIMARY KEY NOT NULL,
	"company_id" integer NOT NULL,
	"supplier_id" integer,
	"purchase_entry_id" integer,
	"note_number" varchar(100) NOT NULL,
	"amount" numeric(12, 2) NOT NULL,
	"reason" text,
	"note_date" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "debit_notes" (
	"id" serial PRIMARY KEY NOT NULL,
	"company_id" integer NOT NULL,
	"supplier_id" integer,
	"purchase_entry_id" integer,
	"note_number" varchar(100) NOT NULL,
	"amount" numeric(12, 2) NOT NULL,
	"reason" text,
	"note_date" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "party_payments" (
	"id" serial PRIMARY KEY NOT NULL,
	"company_id" integer NOT NULL,
	"supplier_id" integer,
	"purchase_entry_id" integer,
	"bank_account_id" integer,
	"amount" numeric(12, 2) NOT NULL,
	"method" varchar(30) DEFAULT 'BANK_TRANSFER' NOT NULL,
	"reference" varchar(100),
	"paid_at" timestamp with time zone DEFAULT now() NOT NULL,
	"notes" text,
	"created_by_user_id" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "purchase_entries" ADD COLUMN "total_amount" numeric(12, 2);--> statement-breakpoint
ALTER TABLE "purchase_entries" ADD COLUMN "due_date" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "purchase_entries" ADD COLUMN "notes" text;--> statement-breakpoint
ALTER TABLE "credit_notes" ADD CONSTRAINT "credit_notes_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "credit_notes" ADD CONSTRAINT "credit_notes_supplier_id_suppliers_id_fk" FOREIGN KEY ("supplier_id") REFERENCES "public"."suppliers"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "credit_notes" ADD CONSTRAINT "credit_notes_purchase_entry_id_purchase_entries_id_fk" FOREIGN KEY ("purchase_entry_id") REFERENCES "public"."purchase_entries"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "debit_notes" ADD CONSTRAINT "debit_notes_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "debit_notes" ADD CONSTRAINT "debit_notes_supplier_id_suppliers_id_fk" FOREIGN KEY ("supplier_id") REFERENCES "public"."suppliers"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "debit_notes" ADD CONSTRAINT "debit_notes_purchase_entry_id_purchase_entries_id_fk" FOREIGN KEY ("purchase_entry_id") REFERENCES "public"."purchase_entries"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "party_payments" ADD CONSTRAINT "party_payments_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "party_payments" ADD CONSTRAINT "party_payments_supplier_id_suppliers_id_fk" FOREIGN KEY ("supplier_id") REFERENCES "public"."suppliers"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "party_payments" ADD CONSTRAINT "party_payments_purchase_entry_id_purchase_entries_id_fk" FOREIGN KEY ("purchase_entry_id") REFERENCES "public"."purchase_entries"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "party_payments" ADD CONSTRAINT "party_payments_bank_account_id_bank_accounts_id_fk" FOREIGN KEY ("bank_account_id") REFERENCES "public"."bank_accounts"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "party_payments" ADD CONSTRAINT "party_payments_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "credit_notes_company_number_uq" ON "credit_notes" USING btree ("company_id","note_number");--> statement-breakpoint
CREATE UNIQUE INDEX "debit_notes_company_number_uq" ON "debit_notes" USING btree ("company_id","note_number");