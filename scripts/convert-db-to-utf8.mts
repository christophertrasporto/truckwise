import postgres from "postgres";
import { migrateDatabase } from "../src/server/db/migrate";

/**
 * One-off repair: a database created on Windows by the embedded Postgres defaulted to WIN1252, which cannot store
 * the peso sign, emoji or most non-Latin names. This copies every row into a fresh UTF8 database and swaps the
 * names. The old database is kept as <name>_old_win1252 and nothing is deleted.
 *
 *   npm run db:to-utf8
 *
 * Stop the dev server first (open connections are closed during the swap).
 */
const adminUrl = process.env.DATABASE_ADMIN_URL;
if (!adminUrl) throw new Error("DATABASE_ADMIN_URL is not set");
const name = new URL(adminUrl).pathname.slice(1);
if (!/^[a-z0-9_]+$/.test(name)) throw new Error("unexpected database name");
const temp = `${name}_utf8_new`;
const backup = `${name}_old_win1252`;
const at = (db: string) => {
  const u = new URL(adminUrl);
  u.pathname = `/${db}`;
  return u.toString();
};

const maint = postgres(at("postgres"), { max: 1, onnotice: () => {} });
const src = postgres(at(name), { max: 1, onnotice: () => {} });

const [{ enc }] = await src<{ enc: string }[]>`select pg_encoding_to_char(encoding) as enc from pg_database where datname = ${name}`;
if (enc === "UTF8") {
  console.log(`${name} is already UTF8; nothing to do`);
  await src.end();
  await maint.end();
  process.exit(0);
}
console.log(`${name} is ${enc}; converting`);

await maint.unsafe(`DROP DATABASE IF EXISTS "${temp}" WITH (FORCE)`);
await maint.unsafe(`CREATE DATABASE "${temp}" ENCODING 'UTF8' LC_COLLATE 'C' LC_CTYPE 'C' TEMPLATE template0`);
await migrateDatabase(at(temp), process.env.APP_DB_PASSWORD ?? "smartload_app");
const dst = postgres(at(temp), { max: 1, onnotice: () => {} });

// Tables in foreign-key order (parents first).
const tables = await src<{ t: string }[]>`select table_name as t from information_schema.tables where table_schema = 'public' and table_type = 'BASE TABLE' and table_name <> '__drizzle_migrations'`;
const deps = await src<{ child: string; parent: string }[]>`
  select c.conrelid::regclass::text as child, c.confrelid::regclass::text as parent
  from pg_constraint c where c.contype = 'f' and c.connamespace = 'public'::regnamespace and c.conrelid <> c.confrelid`;
const order: string[] = [];
const remaining = new Set(tables.map((r) => r.t));
while (remaining.size) {
  const ready = [...remaining].filter((t) => deps.filter((d) => d.child === t).every((d) => !remaining.has(d.parent) || d.parent === t));
  if (ready.length === 0) throw new Error("foreign-key cycle between " + [...remaining].join(", "));
  for (const t of ready) {
    order.push(t);
    remaining.delete(t);
  }
}

await dst.unsafe("SET session_replication_role = replica"); // rows are copied as-is; skip triggers and checks while loading
let copied = 0;
for (const table of order) {
  const rows = await src.unsafe(`select * from "${table}"`);
  const cols = await src<{ column_name: string; data_type: string }[]>`select column_name, data_type from information_schema.columns where table_schema = 'public' and table_name = ${table}`;
  const jsonCols = new Set(cols.filter((c) => c.data_type === "jsonb" || c.data_type === "json").map((c) => c.column_name));
  for (const row of rows) {
    const values = Object.fromEntries(Object.entries(row).map(([k, v]) => [k, jsonCols.has(k) && v !== null ? dst.json(v as never) : v]));
    await dst`insert into ${dst(table)} ${dst(values as never)}`;
  }
  if (rows.length) console.log(`  ${table}: ${rows.length}`);
  copied += rows.length;
}
// bigserial counters continue after the copied ids
for (const [table, seq] of [["audit_log", "audit_log_id_seq"], ["trip_status_events", "trip_status_events_id_seq"]]) {
  await dst.unsafe(`select setval('${seq}', coalesce((select max(id) from "${table}"), 1), (select count(*) > 0 from "${table}"))`);
}

// verify before swapping
for (const table of order) {
  const [a] = await src.unsafe(`select count(*)::int as n from "${table}"`);
  const [b] = await dst.unsafe(`select count(*)::int as n from "${table}"`);
  if (a.n !== b.n) throw new Error(`row count mismatch in ${table}: ${a.n} vs ${b.n}`);
}
await src.end();
await dst.end();

await maint.unsafe(`SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname IN ('${name}', '${temp}') AND pid <> pg_backend_pid()`);
await maint.unsafe(`DROP DATABASE IF EXISTS "${backup}" WITH (FORCE)`);
await maint.unsafe(`ALTER DATABASE "${name}" RENAME TO "${backup}"`);
await maint.unsafe(`ALTER DATABASE "${temp}" RENAME TO "${name}"`);
await maint.end();
console.log(`done: ${copied} rows copied. ${name} is now UTF8; the old one is kept as ${backup}.`);
