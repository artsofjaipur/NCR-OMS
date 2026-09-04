import jwt from "jsonwebtoken";

export interface SessionClaims {
  userId: number;
  companyId: number;
  role: "OWNER" | "ADMIN" | "OPS" | "VIEWER";
}

function getSecret(): string {
  const secret = process.env.JWT_SECRET;
  if (!secret) {
    throw new Error("JWT_SECRET is not set");
  }
  return secret;
}

export function signSession(claims: SessionClaims, expiresIn: jwt.SignOptions["expiresIn"] = "12h"): string {
  // Algorithm pinned to HS256 — never trust an incoming token's own `alg`
  // header, which is the classic JWT "alg: none" / algorithm-confusion bug.
  return jwt.sign(claims, getSecret(), { algorithm: "HS256", expiresIn });
}

export function verifySession(token: string): SessionClaims {
  const decoded = jwt.verify(token, getSecret(), { algorithms: ["HS256"] });
  return decoded as unknown as SessionClaims;
}
