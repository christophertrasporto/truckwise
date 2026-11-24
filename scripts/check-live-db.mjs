// Checks a hosted database without printing any password.
//   $env:CHECK_ADMIN_URL = '<admin connection string>'
//   $env:CHECK_APP_URL   = '<app connection string>'
//   node scripts/check-live-db.mjs
import postgres from "postgres";

const admin = process.env.CHECK_ADMIN_URL;
const app = process.env.CHECK_APP_URL;
if (!admin) throw new Error("Set CHECK_ADMIN_URL first.");

const a = postgres(admin, { max: 1 });
try {
  const role = await a.unsafe("select rolname, rolcanlogin, rolbypassrls, rolsuper from pg_roles where rolname = 'smartload_app'");
  console.log(role.length ? `smartload_app exists: login=${role[0].rolcanlogin} bypassrls=${role[0].rolbypassrls} superuser=${role[0].rolsuper}` : "smartload_app does NOT exist (run: npm run db:migrate:live)");
  const tables = await a.unsafe("select count(*)::int as n from information_schema.tables where table_schema = 'public'");
  console.log(`tables in public: ${tables[0].n}`);
  const migrations = await a.unsafe("select count(*)::int as n from drizzle.__drizzle_migrations").catch(() => [{ n: "unknown" }]);
  console.log(`migrations recorded: ${migrations[0].n}`);
} catch (e) {
  console.log("ADMIN connection FAILED:", e.code, e.message);
} finally {
  await a.end();
}

if (app) {
  const b = postgres(app, { max: 1 });
  try {
    const r = await b.unsafe("select current_user as who");
    console.log(`app connection OK as ${r[0].who}`);
    const t = await b.unsafe("select count(*)::int as n from tenants").catch((e) => ({ error: e.message }));
    console.log("app can read tenants:", t.error ? `no (${t.error})` : "yes");
  } catch (e) {
    console.log("APP connection FAILED:", e.code, e.message);
  } finally {
    await b.end();
  }
}
