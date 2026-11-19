import path from "node:path";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import { adminClient } from "./admin";

/** Applies pending migrations as the owner, then (re)sets the app role's password. */
export async function migrateDatabase(adminUrl: string, appDbPassword: string): Promise<void> {
  const { sql, db } = adminClient(adminUrl);
  try {
    await migrate(db, { migrationsFolder: path.join(process.cwd(), "drizzle") });
    const literal = appDbPassword.replace(/'/g, "''");
    await sql.unsafe(`ALTER ROLE smartload_app WITH LOGIN PASSWORD '${literal}'`);
  } finally {
    await sql.end();
  }
}
