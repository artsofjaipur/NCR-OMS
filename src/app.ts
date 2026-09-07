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
  });
  app.use(limiter);

  // Health Check
  app.get("/health", (_req: Request, res: Response) => {
    res.json({ status: "ok" });
  });

  // API Routes
  app.use("/api/auth", authRouter);
  app.use("/api/companies", companiesRouter);
  app.use("/api/skus", skusRouter);
  app.use("/api/warehouses", warehousesRouter);
  app.use("/api/orders", ordersRouter);
  app.use("/api/dispatch", dispatchRouter);
  app.use("/api/returns", returnsRouter);
  app.use("/api/payouts", payoutsRouter);
  app.use("/api/pnl", pnlRouter);
  app.use("/api/purchases", purchasesRouter);

  // Error Handling Middleware
  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
}

// Default export kept for backward compatibility with any code that
// imports the app directly (e.g. `import app from "./app"`).
export default createApp;
