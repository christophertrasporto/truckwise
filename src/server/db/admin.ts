import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "./schema";

/**
 * Owner/superuser connection that BYPASSES row-level security.
 * For scripts only: migrations, seed, and test setup. Never import from src/app or src/server services
 * (enforced by an ESLint rule).
 */
export function adminClient(url = process.env.DATABASE_ADMIN_URL) {
  if (!url) throw new Error("DATABASE_ADMIN_URL is not set");
  const sql = postgres(url, { max: 2, onnotice: () => {} });
  return { sql, db: drizzle(sql, { schema }) };
}
