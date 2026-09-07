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

export default app;
