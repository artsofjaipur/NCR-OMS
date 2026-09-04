import { Router } from "express";
import { z } from "zod";
import { eq } from "drizzle-orm";
import { db } from "../db/client";
import { companies, bankAccounts } from "../db/schema";
import { requireAuth, requireCompanyScope, requireRole } from "../middleware/auth";
import { encrypt } from "../security/crypto";
import { HttpError } from "../middleware/errorHandler";

export const companiesRouter = Router();
companiesRouter.use(requireAuth, requireCompanyScope);

companiesRouter.get("/me", async (req, res, next) => {
  try {
    const [company] = await db.select().from(companies).where(eq(companies.id, req.session!.companyId)).limit(1);
    if (!company) throw new HttpError(404, "Company not found");
    const accounts = await db.select().from(bankAccounts).where(eq(bankAccounts.companyId, company.id));
    // Never return the encrypted account number blob to the client.
    res.json({
      ...company,
      bankAccounts: accounts.map(({ accountNumberEncrypted, ...rest }) => ({ ...rest, accountNumberMasked: "••••" })),
    });
  } catch (err) {
    next(err);
  }
});

const profileSchema = z.object({
  legalName: z.string().min(1).optional(),
  displayName: z.string().min(1).optional(),
  logoUrl: z.string().url().optional(),
  gstin: z.string().length(15).optional(),
  pan: z.string().length(10).optional(),
  addressLine1: z.string().optional(),
  addressLine2: z.string().optional(),
  city: z.string().optional(),
  state: z.string().optional(),
  stateCode: z.string().length(2).optional(),
  pincode: z.string().length(6).optional(),
  signatoryName: z.string().optional(),
  signatoryDesignation: z.string().optional(),
});

companiesRouter.patch("/me", requireRole("OWNER", "ADMIN"), async (req, res, next) => {
  try {
    const body = profileSchema.parse(req.body);
    await db.update(companies).set(body).where(eq(companies.id, req.session!.companyId));
    res.status(204).end();
  } catch (err) {
    next(err);
  }
});

const bankAccountSchema = z.object({
  label: z.string().min(1),
  accountHolderName: z.string().min(1),
  accountNumber: z.string().min(4),
  ifsc: z.string().length(11),
  bankName: z.string().min(1),
  branchName: z.string().optional(),
  accountType: z.string().optional(),
  isPrimary: z.boolean().optional(),
});

companiesRouter.post("/me/bank-accounts", requireRole("OWNER", "ADMIN"), async (req, res, next) => {
  try {
    const body = bankAccountSchema.parse(req.body);
    const [row] = await db
      .insert(bankAccounts)
      .values({
        companyId: req.session!.companyId,
        label: body.label,
        accountHolderName: body.accountHolderName,
        accountNumberEncrypted: encrypt(body.accountNumber),
        ifsc: body.ifsc,
        bankName: body.bankName,
        branchName: body.branchName,
        accountType: body.accountType,
        isPrimary: body.isPrimary ?? false,
      })
      .returning({ id: bankAccounts.id });
    res.status(201).json({ id: row.id });
  } catch (err) {
    next(err);
  }
});
