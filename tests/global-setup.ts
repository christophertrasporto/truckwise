import postgres from "postgres";
import { migrateDatabase } from "../src/server/db/migrate";
import { seed } from "../src/server/db/seed";

/** Recreates the test database from scratch: migrate + seed, so tests always run against real RLS. */
export default async function setup() {
  const testUrl = process.env.TEST_ADMIN_URL!;
  const dbName = new URL(testUrl).pathname.slice(1);
  const maint = new URL(testUrl);
  maint.pathname = "/postgres";

  const sql = postgres(maint.toString(), { max: 1, onnotice: () => {} });
  await sql.unsafe(`DROP DATABASE IF EXISTS "${dbName}" WITH (FORCE)`);
  // UTF8 explicitly: names, addresses and the peso sign must round-trip whatever the server default is.
  await sql.unsafe(`CREATE DATABASE "${dbName}" ENCODING 'UTF8' LC_COLLATE 'C' LC_CTYPE 'C' TEMPLATE template0`);
  await sql.end();

  await migrateDatabase(testUrl, process.env.APP_DB_PASSWORD ?? "smartload_app");
  await seed(testUrl);
}
