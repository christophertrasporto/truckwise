import postgres from "postgres";

/** Drops and recreates the dev database (local only). Run db:migrate and db:seed afterwards. */
const url = process.env.DATABASE_ADMIN_URL;
if (!url) throw new Error("DATABASE_ADMIN_URL is not set");
const name = new URL(url).pathname.slice(1);
if (!/^[a-z0-9_]+$/.test(name)) throw new Error("unexpected database name");
const maint = new URL(url);
maint.pathname = "/postgres";
const sql = postgres(maint.toString(), { max: 1, onnotice: () => {} });
await sql.unsafe(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`);
await sql.unsafe(`CREATE DATABASE "${name}" ENCODING 'UTF8' LC_COLLATE 'C' LC_CTYPE 'C' TEMPLATE template0`);
await sql.end();
console.log(`database ${name} reset`);
