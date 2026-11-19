import { sql } from "drizzle-orm";
import { drizzle, type PostgresJsDatabase } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { env } from "../env";
import * as schema from "./schema";

/**
 * The ONLY door to the database for application code.
 *
 * The connection uses the `smartload_app` role (no superuser, no BYPASSRLS), and every
 * query runs inside a transaction whose tenant/user context is set with set_config(..., true),
 * so Postgres row-level security scopes it. There is deliberately no export that hands out
 * an unscoped client; forgetting the tenant yields zero rows, not someone else's rows.
 */
export type Db = PostgresJsDatabase<typeof schema>;

export interface DbContext {
  tenantId?: string | null;
  userId?: string | null;
  /** Platform super admin only. Callers must have verified users.is_platform_admin first. */
  platform?: boolean;
}

const globalForDb = globalThis as unknown as { __slSql?: postgres.Sql; __slDb?: Db };

function root(): Db {
  if (!globalForDb.__slDb) {
    globalForDb.__slSql = postgres(env().DATABASE_URL, { max: 10 });
    globalForDb.__slDb = drizzle(globalForDb.__slSql, { schema });
  }
  return globalForDb.__slDb;
}

export async function withContext<T>(ctx: DbContext, fn: (db: Db) => Promise<T>): Promise<T> {
  return root().transaction(async (tx) => {
    await tx.execute(sql`select
      set_config('app.tenant_id', ${ctx.tenantId ?? ""}, true),
      set_config('app.user_id', ${ctx.userId ?? ""}, true),
      set_config('app.is_platform', ${ctx.platform ? "on" : ""}, true)`);
    return fn(tx as unknown as Db);
  });
}

export const withTenant = <T>(tenantId: string, userId: string | null, fn: (db: Db) => Promise<T>) =>
  withContext({ tenantId, userId }, fn);

export const withUser = <T>(userId: string, fn: (db: Db) => Promise<T>) =>
  withContext({ userId }, fn);

export async function closeDb(): Promise<void> {
  await globalForDb.__slSql?.end();
  globalForDb.__slSql = undefined;
  globalForDb.__slDb = undefined;
}

export { schema };
