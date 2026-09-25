-- Stock-In ledger fields on purchase_entries (2026-09-25, by Claude for Ram):
-- Party-wise "Stock In" sheets (APL / Shivam / AK Enterprises / JK etc.) are
-- now full CRUD entries — challan no. (party's + ours), GST%, computed
-- subtotal/GST, and the real-world "In Date" (entryDate), separate from the
-- existing totalAmount (kept as the final payable so Finance/Reports/
-- Assistant queries that already sum totalAmount as "what's owed" keep
-- working unchanged). All additive/nullable — existing rows unaffected, no
-- backfill needed. Hand-written (not `drizzle-kit generate`) per the
-- snapshot-drift note in BRAIN.md — apply with `npx drizzle-kit push`.
ALTER TABLE "purchase_entries" ADD COLUMN "entry_date" timestamp with time zone;
ALTER TABLE "purchase_entries" ADD COLUMN "party_chalan_no" varchar(100);
ALTER TABLE "purchase_entries" ADD COLUMN "our_chalan_no" varchar(100);
ALTER TABLE "purchase_entries" ADD COLUMN "gst_percent" numeric(5, 2);
ALTER TABLE "purchase_entries" ADD COLUMN "subtotal_amount" numeric(12, 2);
ALTER TABLE "purchase_entries" ADD COLUMN "gst_amount" numeric(12, 2);
