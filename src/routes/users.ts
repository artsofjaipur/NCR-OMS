import { Router } from "express";
import { z } from "zod";
import { and, eq, inArray } from "drizzle-orm";
import { db } from "../db/client";
import { users, companies } from "../db/schema";
import { requireAuth, requireCompanyScope, requireRole } from "../middleware/auth";
import { requireSection, SECTIONS } from "../security/permissions";
import { hashPassword } from "../security/password";
import { HttpError } from "../middleware/errorHandler";

export const usersRouter = Router();
usersRouter.use(requireAuth, requireCompanyScope, requireSection("team"));

/**
 * Team management — OWNER/ADMIN decide who exists and what each user can
 * access. ADMINs manage everyone except OWNER accounts (only OWNERs manage
 * OWNERs), so no admin can lock the owner out.
 */
usersRouter.get("/", requireRole("OWNER", "ADMIN"), async (req, res, next) => {
  try {
    const rows = await db
      .select({
        id: users.id,
        email: users.email,
        role: users.role,
        displayName: users.displayName,
        isActive: users.isActive,
        permissions: users.permissions,
        createdAt: users.createdAt,
      })
      .from(users)
      .where(eq(users.companyId, req.session!.companyId))
      .orderBy(users.id);
    res.json(rows);
  } catch (err) {
    next(err);
  }
});

const createSchema = z.object({
  email: z.string().trim().toLowerCase().email(),
  password: z.string().min(8),
  displayName: z.string().trim().min(1).max(150),
  role: z.enum(["ADMIN", "OPS", "VIEWER"]).default("OPS"),
  permissions: z.array(z.enum(SECTIONS)).optional(),
});

usersRouter.post("/", requireRole("OWNER", "ADMIN"), async (req, res, next) => {
  try {
    const body = createSchema.parse(req.body);
    const [dupe] = await db
      .select({ id: users.id })
      .from(users)
      .where(and(eq(users.companyId, req.session!.companyId), eq(users.email, body.email)))
      .limit(1);
    if (dupe) throw new HttpError(409, "A user with this email already exists in your workspace");

    const [row] = await db
      .insert(users)
      .values({
        companyId: req.session!.companyId,
        email: body.email,
        passwordHash: await hashPassword(body.password),
        displayName: body.displayName,
        role: body.role,
        permissions: body.permissions && body.permissions.length ? body.permissions : null,
      })
      .returning({ id: users.id });
    res.status(201).json({ id: row.id });
  } catch (err) {
    next(err);
  }
});

const patchSchema = z
  .object({
    displayName: z.string().trim().min(1).max(150).optional(),
    email: z.string().trim().toLowerCase().email().optional(),
    role: z.enum(["ADMIN", "OPS", "VIEWER"]).optional(),
    isActive: z.boolean().optional(),
    permissions: z.array(z.enum(SECTIONS)).nullable().optional(),
    password: z.string().min(8).optional(),
  })
  .refine((v) => Object.keys(v).length > 0, { message: "Nothing to update" });

usersRouter.patch("/:id", requireRole("OWNER", "ADMIN"), async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) throw new HttpError(400, "Invalid user id");
    const body = patchSchema.parse(req.body);

    const [target] = await db
      .select({ id: users.id, role: users.role })
      .from(users)
      .where(and(eq(users.id, id), eq(users.companyId, req.session!.companyId)))
      .limit(1);
    if (!target) throw new HttpError(404, "User not found in your workspace");

    // Only OWNERs may modify OWNER accounts; OWNER cannot be demoted.
    if (target.role === "OWNER" && req.session!.role !== "OWNER") {
      throw new HttpError(403, "Only an OWNER can modify an OWNER account");
    }
    if (body.role && target.role === "OWNER") {
      throw new HttpError(403, "The OWNER role cannot be changed — ownership transfers manually");
    }
    if (target.role === "OWNER" && body.isActive === false) {
      throw new HttpError(403, "The OWNER account cannot be deactivated");
    }
    if (target.id === req.session!.userId && body.isActive === false) {
      throw new HttpError(403, "You cannot deactivate your own account");
    }

    // Email change — must stay unique inside the workspace.
    if (body.email !== undefined) {
      const [dupe] = await db
        .select({ id: users.id })
        .from(users)
        .where(and(eq(users.companyId, req.session!.companyId), eq(users.email, body.email)))
        .limit(1);
      if (dupe && dupe.id !== id) throw new HttpError(409, "This email is already used by another user in your workspace");
    }

    const patch: Record<string, unknown> = {};
    if (body.displayName !== undefined) patch.displayName = body.displayName;
    if (body.email !== undefined) patch.email = body.email;
    if (body.role !== undefined) patch.role = body.role;
    if (body.isActive !== undefined) patch.isActive = body.isActive;
    // Explicit semantics: null = follow role defaults; [] = no section access
    // at all; ["finance", …] = exactly these sections.
    if (body.permissions !== undefined) patch.permissions = body.permissions ?? null;
    if (body.password !== undefined) patch.passwordHash = await hashPassword(body.password);

    await db.update(users).set(patch).where(eq(users.id, id));
    res.status(204).end();
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------------------
// MULTI-COMPANY ACCESS — "jisko jo company assign karni ho ya sabhi company
// ka access dena ho to vo andar se ho": before this, giving one team member
// access to more than one company meant switching into each company
// yourself and re-adding the same email there by hand, with no guarantee it
// even got the same password. This does it from one place, from inside the
// app, for every company you (the OWNER) yourself belong to -- the exact
// same "same email, one identity, many per-company user rows" pattern
// POST /companies already uses when you add a company for yourself, just
// aimed at a teammate's email instead of your own.
//
// Restricted to OWNER, and only ever touches companies the CALLING owner's
// own identity already has access to -- never a company that owner doesn't
// control, and never a target row whose role is OWNER (that's the "Add
// Company" flow's job, not this one).
// ---------------------------------------------------------------------------

/** Every company the CALLING session's own email is an active member of. */
async function ownerControlledCompanies(sessionUserId: number) {
  const [me] = await db.select({ email: users.email }).from(users).where(eq(users.id, sessionUserId)).limit(1);
  if (!me) return [];
  return db
    .select({ companyId: companies.id, companyName: companies.displayName })
    .from(users)
    .innerJoin(companies, eq(companies.id, users.companyId))
    .where(and(eq(users.email, me.email), eq(users.isActive, true)));
}

usersRouter.get("/:id/access", requireRole("OWNER"), async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) throw new HttpError(400, "Invalid user id");

    const [target] = await db
      .select({ id: users.id, email: users.email, role: users.role })
      .from(users)
      .where(and(eq(users.id, id), eq(users.companyId, req.session!.companyId)))
      .limit(1);
    if (!target) throw new HttpError(404, "User not found in your workspace");
    if (target.role === "OWNER") {
      throw new HttpError(400, "Use \"Add Company\" to manage your own company list — this is for team members");
    }

    const ownerCompanies = await ownerControlledCompanies(req.session!.userId);
    const grantedRows = ownerCompanies.length
      ? await db
          .select({ companyId: users.companyId })
          .from(users)
          .where(
            and(
              eq(users.email, target.email),
              eq(users.isActive, true),
              inArray(
                users.companyId,
                ownerCompanies.map((c) => c.companyId),
              ),
            ),
          )
      : [];
    const grantedIds = new Set(grantedRows.map((r) => r.companyId));

    res.json(ownerCompanies.map((c) => ({ companyId: c.companyId, companyName: c.companyName, granted: grantedIds.has(c.companyId) })));
  } catch (err) {
    next(err);
  }
});

const accessSchema = z.object({ companyIds: z.array(z.number().int().positive()) });

usersRouter.put("/:id/access", requireRole("OWNER"), async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) throw new HttpError(400, "Invalid user id");
    const body = accessSchema.parse(req.body);

    const [target] = await db
      .select()
      .from(users)
      .where(and(eq(users.id, id), eq(users.companyId, req.session!.companyId)))
      .limit(1);
    if (!target) throw new HttpError(404, "User not found in your workspace");
    if (target.role === "OWNER") {
      throw new HttpError(400, "Use \"Add Company\" to manage your own company list — this is for team members");
    }

    const ownerCompanies = await ownerControlledCompanies(req.session!.userId);
    const ownerCompanyIds = new Set(ownerCompanies.map((c) => c.companyId));
    const invalid = body.companyIds.filter((cid) => !ownerCompanyIds.has(cid));
    if (invalid.length) {
      throw new HttpError(403, `You don't have access to grant company id(s): ${invalid.join(", ")}`);
    }
    const wantIds = new Set(body.companyIds);

    await db.transaction(async (tx) => {
      const existingRows = await tx
        .select({ id: users.id, companyId: users.companyId, isActive: users.isActive })
        .from(users)
        .where(and(eq(users.email, target.email), inArray(users.companyId, Array.from(ownerCompanyIds))));
      const existingByCompany = new Map(existingRows.map((r) => [r.companyId, r]));

      for (const companyId of ownerCompanyIds) {
        const wants = wantIds.has(companyId);
        const existing = existingByCompany.get(companyId);

        if (wants && !existing) {
          // New company for this teammate -- same email/password hash,
          // same role and section permissions as their existing account,
          // same reasoning POST /companies already uses for the owner's own
          // identity: one password across every company one person belongs
          // to, never a re-hash of a password we don't have in plaintext.
          await tx.insert(users).values({
            companyId,
            email: target.email,
            passwordHash: target.passwordHash,
            displayName: target.displayName,
            role: target.role,
            permissions: target.permissions,
            isActive: true,
          });
        } else if (wants && existing && !existing.isActive) {
          await tx.update(users).set({ isActive: true }).where(eq(users.id, existing.id));
        } else if (!wants && existing && existing.isActive) {
          // Never revoke the row the caller is acting through right now --
          // same self-protection PATCH /:id already applies to isActive.
          if (existing.id === req.session!.userId) continue;
          await tx.update(users).set({ isActive: false }).where(eq(users.id, existing.id));
        }
      }
    });

    const ownerCompaniesAfter = await ownerControlledCompanies(req.session!.userId);
    const grantedRows = await db
      .select({ companyId: users.companyId })
      .from(users)
      .where(
        and(
          eq(users.email, target.email),
          eq(users.isActive, true),
          inArray(
            users.companyId,
            ownerCompaniesAfter.map((c) => c.companyId),
          ),
        ),
      );
    const grantedIds = new Set(grantedRows.map((r) => r.companyId));
    res.json(ownerCompaniesAfter.map((c) => ({ companyId: c.companyId, companyName: c.companyName, granted: grantedIds.has(c.companyId) })));
  } catch (err) {
    next(err);
  }
});
