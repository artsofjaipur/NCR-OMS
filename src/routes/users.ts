import { Router } from "express";
import { z } from "zod";
import { and, eq } from "drizzle-orm";
import { db } from "../db/client";
import { users } from "../db/schema";
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

    const patch: Record<string, unknown> = {};
    if (body.displayName !== undefined) patch.displayName = body.displayName;
    if (body.role !== undefined) patch.role = body.role;
    if (body.isActive !== undefined) patch.isActive = body.isActive;
    if (body.permissions !== undefined) patch.permissions = body.permissions && body.permissions.length ? body.permissions : null;
    if (body.password !== undefined) patch.passwordHash = await hashPassword(body.password);

    await db.update(users).set(patch).where(eq(users.id, id));
    res.status(204).end();
  } catch (err) {
    next(err);
  }
});
