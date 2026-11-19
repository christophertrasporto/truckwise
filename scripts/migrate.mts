import { migrateDatabase } from "../src/server/db/migrate";

const url = process.env.DATABASE_ADMIN_URL;
if (!url) throw new Error("DATABASE_ADMIN_URL is not set");

await migrateDatabase(url, process.env.APP_DB_PASSWORD ?? "smartload_app");
console.log("migrations applied");
