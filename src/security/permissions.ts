import type { Request, Response, NextFunction } from "express";
import { db } from "../db/client";
import { users } from "../db/schema";
import { eq } from "drizzle-orm";

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

async function effectiveSectionsFor(userId: number, role: string): Promise<Section[]> {
  if (role === "OWNER" || role === "ADMIN") return [...SECTIONS];
  try {
    const [row] = await db.select({ permissions: users.permissions }).from(users).where(eq(users.id, userId)).limit(1);
    if (row && Array.isArray(row.permissions) && row.permissions.length > 0) {
      const valid = row.permissions.filter((p): p is Section => (SECTIONS as readonly string[]).includes(p));
      if (valid.length > 0) return valid;
    }
  } catch {
    // DB hiccup → fall through to role defaults rather than locking everyone out.
  }
  return ROLE_DEFAULTS[role] ?? ROLE_DEFAULTS.VIEWER;
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
