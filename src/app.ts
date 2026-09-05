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
  const app = express();

  app.set("trust proxy", 1);

  const allowedOrigins = (process.env.CORS_ALLOWED_ORIGINS ?? "")
    .split(",")
    .map((origin) => origin.trim())
    .filter(Boolean);

  app.use(
    cors({
      origin: allowedOrigins.length ? allowedOrigins : false,
      credentials: true,
    }),
  );

  app.use(
    helmet({
      contentSecurityPolicy: {
        directives: {
          defaultSrc: ["'none'"],
          frameAncestors: ["'none'"],
        },
      },
      hsts: {
        maxAge: 63072000,
        includeSubDomains: true,
        preload: true,
      },
    }),
  );

  app.use(express.json({ limit: "10mb" }));

  app.use(
    rateLimit({
      windowMs: 60_000,
      limit: 120,
      standardHeaders: true,
      legacyHeaders: false,
    }),
  );

  app.get("/health", (_req: Request, res: Response) => {
    res.json({ status: "ok" });
  });

  app.use("/auth", authRouter);
  app.use("/companies", companiesRouter);
  app.use("/skus", skusRouter);
  app.use("/warehouses", warehousesRouter);
  app.use("/orders", ordersRouter);
  app.use("/dispatch", dispatchRouter);
  app.use("/returns", returnsRouter);
  app.use("/payouts", payoutsRouter);
  app.use("/pnl", pnlRouter);
  app.use("/purchases", purchasesRouter);

  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
}

export default createApp();
