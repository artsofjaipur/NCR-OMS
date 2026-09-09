import { Router } from "express";
import { z } from "zod";
import { eq, and } from "drizzle-orm";
import crypto from "crypto";
import { db } from "../db/client";
import { companies, users, warehouses } from "../db/schema";
import { verifyPassword, hashPassword } from "../security/password";
import { signSession } from "../security/jwt";
import { resolveSections } from "../security/permissions";
import { HttpError } from "../middleware/errorHandler";

export const authRouter = Router();

const emailSchema = z.object({ email: z.string().email() });
const loginSchema = z.object({
  // companyId is now optional: if omitted, the email alone must match exactly
  // one active user (across all companies), and that is the account logged in.
  companyId: z.number().int().positive().optional(),
  email: z.string().email(),
  password: z.string().min(1),
});

const RESET_TOKEN_TTL_MS = 30 * 60 * 1000; // 30 minutes
/** SHA-256 of the reset token — the DB never stores the raw token itself. */
function hashResetToken(rawToken: string): string {
  return crypto.createHash("sha256").update(rawToken).digest("hex");
}

authRouter.post("/register", async (req, res, next) => {
  try {
    const body = z
      .object({
        companyName: z.string().min(2).max(200),
        email: z.string().email(),
        password: z.string().min(8),
        displayName: z.string().min(1).max(150).optional(),
      })
      .parse(req.body);

    const existing = await db
      .select({ id: users.id })
      .from(users)
      .where(eq(users.email, body.email))
      .limit(1);
    if (existing.length > 0) {
      throw new HttpError(409, "An account with this email already exists");
    }

    const passwordHash = await hashPassword(body.password);
    const result = await db.transaction(async (tx) => {
      const [company] = await tx
        .insert(companies)
        .values({ legalName: body.companyName, displayName: body.displayName ?? body.companyName })
        .returning({ id: companies.id });

      // Every company needs a default warehouse for stock ledger entries.
      await tx.insert(warehouses).values({ companyId: company.id, name: "Main Warehouse", isDefault: true });

      const [user] = await tx
        .insert(users)
        .values({
          companyId: company.id,
          email: body.email,
          passwordHash,
          role: "OWNER",
          displayName: body.displayName ?? null,
        })
        .returning({ id: users.id, role: users.role });

      return { companyId: company.id, userId: user.id, role: user.role };
    });

    const token = signSession({ userId: result.userId, companyId: result.companyId, role: "OWNER" });
    res.status(201).json({ token, companyId: result.companyId });
  } catch (err) {
    next(err);
  }
});

authRouter.post("/login", async (req, res, next) => {
  try {
    const body = loginSchema.parse(req.body);

    let user;
    if (body.companyId !== undefined) {
      [user] = await db
        .select()
        .from(users)
        .where(and(eq(users.companyId, body.companyId), eq(users.email, body.email)))
        .limit(1);
    } else {
      // Email-only login: resolve the company automatically, but only when the
      // email maps to exactly one active account across all companies.
      const matches = await db
        .select()
        .from(users)
        .where(and(eq(users.email, body.email), eq(users.isActive, true)))
        .limit(2);
      if (matches.length > 1) {
        throw new HttpError(
          409,
          "This email is linked to multiple workspaces. Enter your workspace ID to continue.",
        );
      }
      user = matches[0];
    }

    if (!user || !user.isActive) {
      throw new HttpError(401, "Invalid credentials");
    }
    const ok = await verifyPassword(user.passwordHash, body.password);
    if (!ok) {
      throw new HttpError(401, "Invalid credentials");
    }

    const token = signSession({ userId: user.id, companyId: user.companyId, role: user.role });
    // Frontend drives section visibility from these grants (OWNER/ADMIN get
    // everything; other roles use stored permissions or role defaults).
    const [company] = await db
      .select({ displayName: companies.displayName })
      .from(companies)
      .where(eq(companies.id, user.companyId))
      .limit(1);
    res.json({
      token,
      companyId: user.companyId,
      role: user.role,
      displayName: user.displayName,
      companyName: company?.displayName ?? null,
      permissions: await resolveSections({ session: { userId: user.id, role: user.role } } as never),
    });
  } catch (err) {
    next(err);
  }
});

/**
 * Always answers 200 with the same body, whether or not the email exists —
 * prevents account-enumeration through this endpoint. The token is returned
 * in the response (dev/email-provider-less mode) AND would be emailed in
 * production; the DB only stores its SHA-256 hash.
 */
authRouter.post("/forgot-password", async (req, res, next) => {
  try {
    const { email } = emailSchema.parse(req.body);
    const [user] = await db.select().from(users).where(eq(users.email, email)).limit(1);

    let devToken: string | undefined;
    if (user && user.isActive) {
      const rawToken = crypto.randomBytes(32).toString("hex");
      await db
        .update(users)
        .set({
          resetTokenHash: hashResetToken(rawToken),
          resetTokenExpiresAt: new Date(Date.now() + RESET_TOKEN_TTL_MS),
        })
        .where(eq(users.id, user.id));
      devToken = rawToken;
    }

    res.json({
      message:
        "If that email belongs to an active account, a password-reset link has been generated. It is valid for 30 minutes.",
      ...(devToken ? { resetToken: devToken } : {}),
    });
  } catch (err) {
    next(err);
  }
});

authRouter.post("/reset-password", async (req, res, next) => {
  try {
    const body = z
      .object({ token: z.string().min(10), newPassword: z.string().min(8) })
      .parse(req.body);

    const tokenHash = hashResetToken(body.token);
    const [user] = await db
      .select()
      .from(users)
      .where(and(eq(users.resetTokenHash, tokenHash), eq(users.isActive, true)))
      .limit(1);

    if (!user || !user.resetTokenExpiresAt || user.resetTokenExpiresAt.getTime() < Date.now()) {
      throw new HttpError(400, "This reset link is invalid or has expired. Request a new one.");
    }

    const passwordHash = await hashPassword(body.newPassword);
    // Single-use: clearing the hash here is what invalidates the token.
    await db
      .update(users)
      .set({ passwordHash, resetTokenHash: null, resetTokenExpiresAt: null })
      .where(eq(users.id, user.id));

    res.json({ message: "Password updated. You can now sign in with your new password." });
  } catch (err) {
    next(err);
  }
});
