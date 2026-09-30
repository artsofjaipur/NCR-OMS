-- Company setup fields (2026-09-10, by Buffy/Codebuff for Ram):
-- order_reference_prefix (PO NO. / RF NO. / RG NO.), IEC, phone, whatsapp, email
ALTER TABLE "companies" ADD COLUMN "order_reference_prefix" varchar(20);
ALTER TABLE "companies" ADD COLUMN "iec" varchar(20);
ALTER TABLE "companies" ADD COLUMN "phone" varchar(20);
ALTER TABLE "companies" ADD COLUMN "whatsapp" varchar(20);
ALTER TABLE "companies" ADD COLUMN "email" varchar(255);

-- AD Code on bank accounts (printed on export invoices)
ALTER TABLE "bank_accounts" ADD COLUMN "ad_code" varchar(30);
