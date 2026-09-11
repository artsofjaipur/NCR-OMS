-- Return classification fields (2026-09-11, by Claude for Ram):
-- returnType captures the marketplace's RTO-vs-customer-return split (from
-- the return sheet's "Return Type" column when present, or a best-effort
-- keyword classification of the reason text otherwise); reason stores the
-- marketplace's freeform return/RTO reason text. Both nullable and additive
-- — existing rows are unaffected, no backfill needed.
ALTER TABLE "returns" ADD COLUMN "return_type" varchar(40);
ALTER TABLE "returns" ADD COLUMN "reason" text;
