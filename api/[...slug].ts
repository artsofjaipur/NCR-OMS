import "dotenv/config";
import { createApp } from "../src/app";

// Vercel serverless catch-all under /api/**. The same Express app used for
// local dev and any persistent-process host, exported directly as a
// handler — Vercel's Node runtime knows how to call an Express app.
export default createApp();
