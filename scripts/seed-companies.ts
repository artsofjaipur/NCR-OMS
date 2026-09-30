/**
 * Seed the three real companies into a fresh workspace database.
 * Idempotent: re-running does NOT duplicate rows (matched on legalName).
 *
 * Run from your machine against the Supabase session-pooler URL:
 *   DATABASE_URL="<session-pooler-url>" npx tsx scripts/seed-companies.ts
 *
 * Creates: 3 companies (+ prefixes, GSTIN, IEC, contacts), PNB bank
 * accounts with AD codes, one default warehouse per company. Brands,
 * marketplace accounts and SKUs are added from the dashboard UI afterwards
 * (or via scripts/smoke.ts for a full end-to-end fixture).
 */
import "dotenv/config";
import { eq } from "drizzle-orm";
import { db, pool } from "../src/db/client";
import { companies, bankAccounts, warehouses } from "../src/db/schema";
import { encrypt } from "../src/security/crypto";

interface CompanySeed {
  legalName: string;
  displayName: string;
  orderReferencePrefix: string;
  gstin: string;
  iec: string;
  pan: string;
  addressLine1: string;
  city: string;
  state: string;
  stateCode: string;
  pincode: string;
  phone: string;
  whatsapp?: string;
  email: string;
  bank: {
    label: string;
    accountHolderName: string;
    accountNumber: string;
    ifsc: string;
    bankName: string;
    adCode: string;
  };
}

const SEEDS: CompanySeed[] = [
  {
    legalName: "Nyko Mart",
    displayName: "NYKO MART",
    orderReferencePrefix: "PO NO.",
    gstin: "08CVAPS0200H1Z0",
    iec: "CVAPS0200H",
    pan: "CVAPS0200H",
    addressLine1: "D-489, Sector-29, Pratap Nagar",
    city: "Jaipur",
    state: "Rajasthan",
    stateCode: "08",
    pincode: "302033",
    phone: "+91 141 480 5979",
    whatsapp: "+91 774099 1175",
    email: "info.nykomart@gmail.com",
    bank: {
      label: "PNB Primary",
      accountHolderName: "Nyko Mart",
      accountNumber: "6143002100005132",
      ifsc: "PUNB0614300",
      bankName: "PNB BANK",
      adCode: "0304993/PUNB0614300",
    },
  },
  {
    legalName: "Casa Arra",
    displayName: "CASA ARRA",
    orderReferencePrefix: "RF NO.",
    gstin: "08AUXPR4630C1ZA",
    iec: "AUXPR4630C",
    pan: "AUXPR4630C",
    addressLine1: "Plot No. 80, Ashadeep Green Vatika, Sanganer, Bagru",
    city: "Jaipur",
    state: "Rajasthan",
    stateCode: "08",
    pincode: "303905",
    phone: "+91 92540 75423",
    email: "info.casaarra@gmail.com",
    bank: {
      label: "PNB Primary",
      accountHolderName: "Casa Arra",
      accountNumber: "6143002100008801",
      ifsc: "PUNB0614300",
      bankName: "PNB BANK",
      adCode: "0304993/PUNB0614300",
    },
  },
  {
    legalName: "Rugara",
    displayName: "RUGARA",
    orderReferencePrefix: "RG NO.",
    gstin: "08BDHPL8126K1Z6",
    iec: "BDHPL8126K",
    pan: "BDHPL8126K",
    addressLine1: "D-489, Sector-29, Pratap Nagar",
    city: "Jaipur",
    state: "Rajasthan",
    stateCode: "08",
    pincode: "302033",
    phone: "+91 96362 63302",
    whatsapp: "+91 63779 11920",
    email: "info.rugara@gmail.com",
    bank: {
      label: "PNB Primary",
      accountHolderName: "Rugara",
      accountNumber: "6143002100008005",
      ifsc: "PUNB0614300",
      bankName: "PNB BANK",
      adCode: "0304993/PUNB0614300",
    },
  },
];

async function main() {
  for (const seed of SEEDS) {
    const [existing] = await db
      .select({ id: companies.id })
      .from(companies)
      .where(eq(companies.legalName, seed.legalName))
      .limit(1);

    if (existing) {
      // Update in place so corrections flow through on re-run.
      await db
        .update(companies)
        .set({
          displayName: seed.displayName,
          orderReferencePrefix: seed.orderReferencePrefix,
          gstin: seed.gstin,
          pan: seed.pan,
          iec: seed.iec,
          addressLine1: seed.addressLine1,
          city: seed.city,
          state: seed.state,
          stateCode: seed.stateCode,
          pincode: seed.pincode,
          phone: seed.phone,
          whatsapp: seed.whatsapp ?? null,
          email: seed.email,
        })
        .where(eq(companies.id, existing.id));

      const [bankHit] = await db
        .select({ id: bankAccounts.id })
        .from(bankAccounts)
        .where(eq(bankAccounts.companyId, existing.id))
        .limit(1);
      if (!bankHit) {
        await db.insert(bankAccounts).values({
          companyId: existing.id,
          label: seed.bank.label,
          accountHolderName: seed.bank.accountHolderName,
          accountNumberEncrypted: encrypt(seed.bank.accountNumber),
          ifsc: seed.bank.ifsc,
          bankName: seed.bank.bankName,
          adCode: seed.bank.adCode,
          isPrimary: true,
        });
      }
      const [whHit] = await db
        .select({ id: warehouses.id })
        .from(warehouses)
        .where(eq(warehouses.companyId, existing.id))
        .limit(1);
      if (!whHit) {
        await db.insert(warehouses).values({
          companyId: existing.id,
          name: seed.displayName + " Main WH",
          city: seed.city,
          isDefault: true,
        });
      }
      console.log("updated:", seed.displayName, "(id", existing.id + ")");
      continue;
    }

    const [company] = await db
      .insert(companies)
      .values({
        legalName: seed.legalName,
        displayName: seed.displayName,
        orderReferencePrefix: seed.orderReferencePrefix,
        gstin: seed.gstin,
        pan: seed.pan,
        iec: seed.iec,
        addressLine1: seed.addressLine1,
        city: seed.city,
        state: seed.state,
        stateCode: seed.stateCode,
        pincode: seed.pincode,
        phone: seed.phone,
        whatsapp: seed.whatsapp ?? null,
        email: seed.email,
      })
      .returning({ id: companies.id });

    await db.insert(bankAccounts).values({
      companyId: company.id,
      label: seed.bank.label,
      accountHolderName: seed.bank.accountHolderName,
      accountNumberEncrypted: encrypt(seed.bank.accountNumber),
      ifsc: seed.bank.ifsc,
      bankName: seed.bank.bankName,
      adCode: seed.bank.adCode,
      isPrimary: true,
    });

    await db.insert(warehouses).values({
      companyId: company.id,
      name: seed.displayName + " Main WH",
      city: seed.city,
      isDefault: true,
    });

    console.log("created:", seed.displayName, "(id", company.id + ")");
  }

  await pool.end();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
