import type { Request, Response, NextFunction } from "express";
import { db } from "../db/client";
import { users } from "../db/schema";
import { and, eq } from "drizzle-orm";

/**
 * Section-level permissions, decided by OWNER/ADMIN per user (2026-09-09).
 * A section gate is satisfied by the role OR an explicit grant stored on the
 * user row, so owners can hand e.g. only Finance to an OPS user. OWNER and
 * ADMIN are always full-access.
 */
export const SECTIONS = [
  "orders",
  "scan",
  "inventory",
  "dispatch",
  "returns",
  "finance",
  "reports",
  "setup",
  "team",
] as const;
export type Section = (typeof SECTIONS)[number];

/** What each role gets when the user row has no explicit overrides. */
const ROLE_DEFAULTS: Record<string, Section[]> = {
  OWNER: [...SECTIONS],
  ADMIN: [...SECTIONS],
  OPS: ["orders", "scan", "inventory", "dispatch", "returns"],
  VIEWER: ["orders", "reports"],
};

export interface PermissionService {
  has(req: Request, section: Section): boolean;
}

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      /** Resolved lazily per request by requireSection / can(). */
      effectiveSections?: Section[];
    }
  }
}

/**
 * Same role/permissions → sections logic used by effectiveSectionsFor below,
 * pulled out so scannableCompanyIds() (cross-company scan, see there) can
 * apply the identical rule to *other* companies' user rows without a
 * separate per-row DB round trip for each one.
 */
export function sectionsFor(role: string, permissions: unknown): Section[] {
  if (role === "OWNER" || role === "ADMIN") return [...SECTIONS];
  if (Array.isArray(permissions) && permissions.length > 0) {
    const valid = permissions.filter((p): p is Section => (SECTIONS as readonly string[]).includes(p));
    if (valid.length > 0) return valid;
  }
  return ROLE_DEFAULTS[role] ?? ROLE_DEFAULTS.VIEWER;
}

async function effectiveSectionsFor(userId: number, role: string): Promise<Section[]> {
  if (role === "OWNER" || role === "ADMIN") return [...SECTIONS];
  try {
    const [row] = await db.select({ permissions: users.permissions }).from(users).where(eq(users.id, userId)).limit(1);
    if (row) return sectionsFor(role, row.permissions);
  } catch {
    // DB hiccup → fall through to role defaults rather than locking everyone out.
  }
  return ROLE_DEFAULTS[role] ?? ROLE_DEFAULTS.VIEWER;
}

/**
 * Every companyId this user's email has ACTIVE access to, where their role
 * there grants `section` — the trust boundary the cross-company Scan
 * Station relies on (see dispatch.ts /scan and returns.ts /scan): "same
 * person, one identity, every company they're legitimately in" — the exact
 * pattern POST /companies and the multi-company access feature already use,
 * just read instead of written. Never includes a company this email has no
 * row in, or a company where their role/permissions there don't include the
 * section, even if their CURRENT session's company does.
 */
export async function scannableCompanyIds(sessionUserId: number, section: Section): Promise<number[]> {
  const [me] = await db.select({ email: users.email }).from(users).where(eq(users.id, sessionUserId)).limit(1);
  if (!me) return [];
  const rows = await db
    .select({ companyId: users.companyId, role: users.role, permissions: users.permissions })
    .from(users)
    .where(and(eq(users.email, me.email), eq(users.isActive, true)));
  return rows.filter((r) => sectionsFor(r.role, r.permissions).includes(section)).map((r) => r.companyId);
}

/** Resolve (and cache on the request) the caller's accessible sections. */
export async function resolveSections(req: Request): Promise<Section[]> {
  if (!req.effectiveSections) {
    req.effectiveSections = req.session
      ? await effectiveSectionsFor(req.session.userId, req.session.role)
      : [];
  }
  return req.effectiveSections;
}

/** Express gate: 403 unless the caller can use this section. */
export function requireSection(section: Section) {
  return async (req: Request, res: Response, next: NextFunction) => {
    try {
      const sections = await resolveSections(req);
      if (!sections.includes(section)) {
        return res.status(403).json({ error: `No access to ${section} — ask an OWNER/ADMIN for permission` });
      }
      next();
    } catch (err) {
      next(err);
    }
  };
}
