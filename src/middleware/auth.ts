import { Request, Response, NextFunction } from "express";
import { verifySession, SessionClaims } from "../security/jwt";

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      session?: SessionClaims;
    }
  }
}

export function requireAuth(req: Request, res: Response, next: NextFunction) {
  const header = req.headers.authorization;
  if (!header?.startsWith("Bearer ")) {
    return res.status(401).json({ error: "Missing bearer token" });
  }
  try {
    req.session = verifySession(header.slice("Bearer ".length));
    next();
  } catch {
    return res.status(401).json({ error: "Invalid or expired session" });
  }
}

/** Every row a request can touch is scoped to the caller's own company. */
export function requireCompanyScope(req: Request, res: Response, next: NextFunction) {
  if (!req.session?.companyId) {
    return res.status(403).json({ error: "No company scope on session" });
  }
  next();
}

export function requireRole(...allowed: SessionClaims["role"][]) {
  return (req: Request, res: Response, next: NextFunction) => {
    if (!req.session || !allowed.includes(req.session.role)) {
      return res.status(403).json({ error: "Insufficient role for this action" });
    }
    next();
  };
}
