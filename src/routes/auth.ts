import { Router } from "express";
import { z } from "zod";
import { eq, and } from "drizzle-orm";
import { db } from "../db/client";
import { users } from "../db/schema";
import { verifyPassword } from "../security/password";
import { signSession } from "../security/jwt";
import { HttpError } from "../middleware/errorHandler";

export const authRouter = Router();

const loginSchema = z.object({
  companyId: z.number().int().positive(),
  email: z.string().email(),
  password: z.string().min(1),
});

authRouter.post("/login", async (req, res, next) => {
  try {
    const body = loginSchema.parse(req.body);
    const [user] = await db
      .select()
      .from(users)
      .where(and(eq(users.companyId, body.companyId), eq(users.email, body.email)))
      .limit(1);

    if (!user || !user.isActive) {
      throw new HttpError(401, "Invalid credentials");
    }
    const ok = await verifyPassword(user.passwordHash, body.password);
    if (!ok) {
      throw new HttpError(401, "Invalid credentials");
    }

    const token = signSession({ userId: user.id, companyId: user.companyId, role: user.role });
    res.json({ token });
  } catch (err) {
    next(err);
  }
});
