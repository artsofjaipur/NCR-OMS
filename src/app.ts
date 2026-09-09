/**
 * NCR-OMS — Express application factory
 * ---------------------------------------------------------------
 * Fixed by Claude (Anthropic): this file previously built and exported
 * a single `app` instance as the DEFAULT export. Every consumer in the
 * repo (src/server.ts, api/index.ts, api/[...slug].ts, scripts/smoke.ts)
 * imports a NAMED `createApp` factory instead, which caused a hard
 * TypeScript build failure (TS2614: "has no exported member 'createApp'")
 * and would have broken local dev, the Vercel serverless functions, and
 * the smoke test simultaneously.
 *
 * Fix: wrap the whole app construction in an exported `createApp()`
 * function so every consumer gets a fresh, correctly-typed Express app.
 * See BUGRESOLVE.md for the full write-up of this fix.
 * ------------------------- Claude signature ----------------------
 */
import express, { Express, Request, Response } from "express";
import cors from "cors";
import helmet from "helmet";
import rateLimit from "express-rate-limit";
import path from "path";
import fs from "fs";

// Static frontend (3D landing + auth pages) served by the same Express app.
// Resolved robustly: tsx runs from src/, tsc output lands in dist/src/, and
// Vercel runs with cwd at the project root — pick whichever candidate
// actually contains the built site.
function resolvePublicDir(): string {
  const candidates = [
    path.join(process.cwd(), "public"),
    path.join(__dirname, "..", "public"),
    path.join(__dirname, "..", "..", "public"),
  ];
  for (const dir of candidates) {
    if (fs.existsSync(path.join(dir, "index.html"))) return dir;
  }
  return candidates[0];
}
const PUBLIC_DIR = resolvePublicDir();

import { authRouter } from "./routes/auth";
import { companiesRouter } from "./routes/companies";
import { skusRouter } from "./routes/skus";
import { warehousesRouter } from "./routes/warehouses";
import { ordersRouter } from "./routes/orders";
import { dispatchRouter } from "./routes/dispatch";
import { returnsRouter } from "./routes/returns";
import { payoutsRouter } from "./routes/payouts";
import { pnlRouter } from "./routes/pnl";
import { purchasesRouter } from "./routes/purchases";

import {
  errorHandler,
  notFoundHandler,
} from "./middleware/errorHandler";

export function createApp(): Express {
  const app: Express = express();

  // Trust Vercel's reverse proxy
  app.set("trust proxy", 1);

  // Body Parsers
  app.use(express.json({ limit: "10mb" }));
  app.use(express.urlencoded({ extended: true }));

  // Security Headers
  app.use(helmet());

  // CORS Configuration
  const allowedOrigins = process.env.CORS_ALLOWED_ORIGINS
    ? process.env.CORS_ALLOWED_ORIGINS.split(",").map((o) => o.trim()).filter(Boolean)
    : "*";

  app.use(
    cors({
      origin: allowedOrigins,
      credentials: true,
    })
  );

  // Rate Limiting
  const limiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    limit: 100,
    standardHeaders: "draft-7",
    legacyHeaders: false,
    // Fixed by Claude (Anthropic): Vercel's proxy chain depth doesn't reliably
    // match a fixed `trust proxy` hop count, so express-rate-limit's strict
    // X-Forwarded-For validation was throwing ValidationError
    // (ERR_ERL_UNEXPECTED_X_FORWARDED_FOR) on every single request in
    // production, crashing the function (FUNCTION_INVOCATION_FAILED / 300s
    // timeout). See BUGRESOLVE.md Bug #2.
    validate: { xForwardedForHeader: false },
  });
  app.use(limiter);

  // Health Check
  app.get("/health", (_req: Request, res: Response) => {
    res.json({ status: "ok" });
  });

  // ---------------- Static frontend ----------------
  // Explicit page routes first (so /login, /create-account, /forgot-password,
  // /reset-password resolve directly), then the static middleware for assets,
  // then index.html as the root.
  app.use(express.static(PUBLIC_DIR, { index: false, maxAge: "1h" }));
  app.get(["/", "/index.html"], (_req: Request, res: Response) => {
    res.sendFile(path.join(PUBLIC_DIR, "index.html"));
  });
  app.get("/login", (_req: Request, res: Response) => {
    res.sendFile(path.join(PUBLIC_DIR, "login.html"));
  });
  app.get("/create-account", (_req: Request, res: Response) => {
    res.sendFile(path.join(PUBLIC_DIR, "create-account.html"));
  });
  app.get("/forgot-password", (_req: Request, res: Response) => {
    res.sendFile(path.join(PUBLIC_DIR, "forgot-password.html"));
  });
  app.get("/reset-password", (_req: Request, res: Response) => {
    res.sendFile(path.join(PUBLIC_DIR, "reset-password.html"));
  });

  // API Routes
  // Fixed by Claude (Anthropic): mounted at both the bare path and the
  // /api-prefixed path. Vercel's rewrite (vercel.json) sends every request
  // to this same function while preserving the client's original URL, so
  // depending on how a client calls the API (with or without /api/), either
  // form now resolves to the same router. See BUGRESOLVE.md Bug #4.
  const routeMounts: Array<[string, express.Router]> = [
    ["/auth", authRouter],
    ["/companies", companiesRouter],
    ["/skus", skusRouter],
    ["/warehouses", warehousesRouter],
    ["/orders", ordersRouter],
    ["/dispatch", dispatchRouter],
    ["/returns", returnsRouter],
    ["/payouts", payoutsRouter],
    ["/pnl", pnlRouter],
    ["/purchases", purchasesRouter],
  ];
  for (const [path, router] of routeMounts) {
    app.use(path, router);
    app.use(`/api${path}`, router);
  }

  // Error Handling Middleware
  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
}

// Default export kept for backward compatibility with any code that
// imports the app directly (e.g. `import app from "./app"`).
export default createApp;
