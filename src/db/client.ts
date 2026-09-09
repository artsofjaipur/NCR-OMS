import { Pool } from "pg";
import { drizzle, NodePgDatabase } from "drizzle-orm/node-postgres";
import * as schema from "./schema";

const connectionString = process.env.DATABASE_URL;

// Supabase hosts (both the direct connection and the pgbouncer transaction
// pooler on :6543) require SSL; a bare local/self-hosted Postgres usually
// doesn't. Detect rather than hardcode so the same code runs locally,
// against Supabase, and against any other managed Postgres.
const isSupabaseHost = (url: string) =>
  /supabase\.(co|com|in)/i.test(url) || /pooler\.supabase/i.test(url);

// On Vercel every serverless invocation can open its own pool, so keep this
// small — the pooler (Supabase's Transaction pooler, port 6543) is what's
// meant to absorb that fan-out, not a large pool per invocation.
const poolMax = Number(process.env.DATABASE_POOL_MAX ?? (process.env.VERCEL ? 3 : 10));

export const pool = new Pool({
  connectionString,
  max: poolMax,
  // pg.Pool connects lazily — no DATABASE_URL means every *query* fails, but
  // the process (and the static landing/auth pages) still boots. That keeps
  // previews usable before credentials are configured.
  ssl: connectionString && isSupabaseHost(connectionString) ? { rejectUnauthorized: false } : undefined,
});

// An idle client dying (network blip, pooler restart) must not crash the
// process — log it and let the pool replace the client.
pool.on("error", (err) => {
  // eslint-disable-next-line no-console
  console.error("[db] idle client error:", err.message);
});

type Db = NodePgDatabase<typeof schema>;

function createDb(): Db {
  if (!connectionString) {
    // Fail loudly and clearly on the first DB touch, instead of crashing at
    // boot and taking the static frontend down with it.
    return new Proxy({} as Db, {
      get() {
        throw new Error(
          "DATABASE_URL is not set — add it in Settings → Environment to enable the API.",
        );
      },
    });
  }
  return drizzle(pool, { schema });
}

export const db = createDb();
