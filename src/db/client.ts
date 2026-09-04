import { Pool } from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import * as schema from "./schema";

const connectionString = process.env.DATABASE_URL;
if (!connectionString) {
  throw new Error("DATABASE_URL is not set");
}

// Supabase hosts (both the direct connection and the pgbouncer transaction
// pooler on :6543) require SSL; a bare local/self-hosted Postgres usually
// doesn't. Detect rather than hardcode so the same code runs locally,
// against Supabase, and against any other managed Postgres.
const isSupabaseHost = /supabase\.(co|com|in)/i.test(connectionString) || /pooler\.supabase/i.test(connectionString);

// On Vercel every serverless invocation can open its own pool, so keep this
// small — the pooler (Supabase's Transaction pooler, port 6543) is what's
// meant to absorb that fan-out, not a large pool per invocation.
const poolMax = Number(process.env.DATABASE_POOL_MAX ?? (process.env.VERCEL ? 3 : 10));

export const pool = new Pool({
  connectionString,
  max: poolMax,
  ssl: isSupabaseHost ? { rejectUnauthorized: false } : undefined,
});

export const db = drizzle(pool, { schema });
