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
import { suppliersRouter } from "./routes/suppliers";
import { financeRouter } from "./routes/finance";
import { usersRouter } from "./routes/users";
import { reportsRouter } from "./routes/reports";
import { entryRouter } from "./routes/entry";
import { dashboardRouter } from "./routes/dashboard";
import { assistantRouter } from "./routes/assistant";
import { settlementsRouter } from "./routes/settlements";

import {
  errorHandler,
  notFoundHandler,
} from "./middleware/errorHandler";

export function createApp(): Express {
  const app: Express = express();

  // Trust Vercel's reverse proxy
  app.set("trust proxy", 1);

  // Body Parsers
  // Bumped from 10mb -> 40mb by Claude (Anthropic) 2026-09-25: settlement
  // sheet imports (POST /settlements/import) send a base64-encoded .xlsx in
  // the JSON body, same "read client-side, POST as JSON" convention the CSV
  // importers already use — base64 inflates size ~33%, so a 25MB source
  // file (the route's own hard cap) needs ~34MB of body room.
  app.use(express.json({ limit: "40mb" }));
  app.use(express.urlencoded({ extended: true }));

  // Security Headers
  // connect-src includes docs.google.com so the Import-from-Google-Sheet
  // panel can fetch the sheet's CSV export straight from the user's browser
  // (its first-choice path; the server-side fetch remains the fallback).
  app.use(
    helmet({
      contentSecurityPolicy: {
        directives: {
          ...helmet.contentSecurityPolicy.getDefaultDirectives(),
          "connect-src": ["'self'", "https://docs.google.com"],
          // Allows exactly one small inline snippet (byte-identical on every
          // authed page, see public/*.html): restores the saved content
          // theme onto <html data-theme> before app.css/nav.js even load,
          // so there's no flash of the default theme on page load. Added by
          // Claude (Anthropic) 2026-09-25 alongside the theme picker
          // (public/nav.js) -- found via real browser testing that the
          // default helmet CSP (script-src 'self') silently blocks ANY
          // inline <script>, so this hash-allowlists that one exact
          // snippet rather than weakening the policy with 'unsafe-inline'.
          // If that snippet's text ever changes, this hash must be
          // recomputed (sha256, base64) or the snippet silently stops
          // running again.
          "script-src": ["'self'", "'sha256-6v4qHajW8nxkM7PQiEGo2CMYjPMg1zgru00x5p7rfAM='"],
        },
      },
    })
  );

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
  app.get(["/", "/index.html", "/home"], (_req: Request, res: Response) => {
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
  // Authenticated dashboard shell. The page itself guards on the session
  // token and redirects to /login when absent.
  app.get("/app", (_req: Request, res: Response) => {
    res.sendFile(path.join(PUBLIC_DIR, "app.html"));
  });
  app.get("/scan", (_req: Request, res: Response) => {
    res.sendFile(path.join(PUBLIC_DIR, "scan.html"));
  });
  // Finance (Zoho Books-style money view): bills, payouts, payments, notes.
  app.get("/finance", (_req: Request, res: Response) => {
    res.sendFile(path.join(PUBLIC_DIR, "finance.html"));
  });
  // Reports: turnover, P&L, balance sheet, expenses, store fees.
  app.get("/reports", (_req: Request, res: Response) => {
    res.sendFile(path.join(PUBLIC_DIR, "reports.html"));
  });
  // Company & Setup / Party Master / Single Entry / Team & Roles — split out
  // of /app's in-page anchors into real standalone pages by Claude
  // (Anthropic) 2026-09-11, per user request. See BRAIN.md.
  app.get("/setup", (_req: Request, res: Response) => {
    res.sendFile(path.join(PUBLIC_DIR, "setup.html"));
  });
  app.get("/party", (_req: Request, res: Response) => {
    res.sendFile(path.join(PUBLIC_DIR, "party.html"));
  });
  app.get("/entry", (_req: Request, res: Response) => {
    res.sendFile(path.join(PUBLIC_DIR, "entry.html"));
  });
  app.get("/team", (_req: Request, res: Response) => {
    res.sendFile(path.join(PUBLIC_DIR, "team.html"));
  });
  // Returns Tracking: "Upcoming Returns / Pending" + "Expected vs Received"
  // — added 2026-09-25 per user request. Safe to claim the bare path: the
  // returns API's own GET "/" (the raw returns list) has no frontend caller
  // today (confirmed via grep) and stays reachable at /api/returns; every
  // page under this router only ever calls a nested path (/returns/import,
  // /returns/scan, /returns/tracking), same pattern as /reports.
  app.get("/returns", (_req: Request, res: Response) => {
    res.sendFile(path.join(PUBLIC_DIR, "returns.html"));
  });
  // Orders list (search/filter/edit/cancel/delete) — split out of /app's
  // KPI+Daily-Summary dashboard into its own page 2026-09-25, per user
  // request (Hinglish): "dusra summery desboard par hai jo sahi hai lekin
  // order page bhi vahi par ahi dono ko alag alag kaam hai to usi hisab se
  // karo" — dashboard summary and the order list are different jobs and
  // shouldn't share one page. UNLIKE /returns above, this one bare path
  // genuinely collides: ordersRouter's own GET "/" *is* the live order
  // list, and public/app.js (now orders.js) called it at the bare path.
  // Fixed the collision at the call site instead of avoiding the URL —
  // orders.js now calls /api/orders explicitly (the /api-prefixed mount
  // always reaches the router regardless of any page route sitting on the
  // bare path, per the routeMounts loop below) — so this page route is
  // safe to register.
  app.get("/orders", (_req: Request, res: Response) => {
    res.sendFile(path.join(PUBLIC_DIR, "orders.html"));
  });
  // Marketplace payment/settlement-sheet reconciliation — added 2026-09-25.
  // Bare path is safe to claim here: settlementsRouter's own GET "/" (the
  // import history list) has no frontend caller at the bare path — every
  // call site uses /api/settlements/... explicitly (see public/payments.js).
  app.get("/payments", (_req: Request, res: Response) => {
    res.sendFile(path.join(PUBLIC_DIR, "payments.html"));
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
    ["/suppliers", suppliersRouter],
    ["/finance", financeRouter],
    ["/users", usersRouter],
    ["/reports", reportsRouter],
    ["/entry", entryRouter],
    ["/dashboard", dashboardRouter],
    ["/assistant", assistantRouter],
    ["/settlements", settlementsRouter],
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
