/**
 * Loads a spreadsheet of costs into a company's Costs ledger, one row per cost.
 *
 *   npx tsx --env-file=.env scripts/import-costs.mts "C:\path\Expenses.xlsx" --owner you@example.com [--dry-run]
 *
 * Columns, with no header row: date, type (Expense or Income), category, amount (for example "₱1,000.00"), description.
 * Only Expense rows are imported; Income rows are not costs and are listed but skipped. Each row gets a fixed
 * idempotency key (from the file's contents and the row number), so running it twice never records anything twice.
 * The description is kept on the cost; for Salary rows it is the person paid.
 */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { and, eq, ilike, like } from "drizzle-orm";
import ExcelJS from "exceljs";
import { adminClient } from "../src/server/db/admin";
import { closeDb } from "../src/server/db";
import { companyExpenses, customers, memberships, tenants, trucks, users } from "../src/server/db/schema";
import { addCost, voidCost } from "../src/server/services/finance/costs";
import { addTruck } from "../src/server/services/fleet";
import { addIncome } from "../src/server/services/finance/income";
import { formatPeso } from "../src/shared/format";
import type { CostCategory } from "../src/shared/costs";

const args = process.argv.slice(2);
const file = args.find((a) => !a.startsWith("--"));
const dryRun = args.includes("--dry-run");
const incomeOnly = args.includes("--income-only");
const ownerArg = args.indexOf("--owner");
const ownerEmail = (ownerArg >= 0 ? args[ownerArg + 1] : process.env.OWNER_EMAIL)?.toLowerCase();
if (!file || !ownerEmail) throw new Error('Usage: import-costs.mts "<file.xlsx>" --owner <owner email> [--dry-run]');

const CATEGORY: Record<string, CostCategory> = {
  diesel: "diesel",
  rfid: "rfid",
  salary: "salary",
  maintenance: "maintenance",
  "other expenses": "other",
};

const raw = (v: unknown) => (v && typeof v === "object" && "result" in (v as object) ? (v as { result: unknown }).result : v);
const centavos = (v: unknown): number | null => {
  const n = typeof raw(v) === "number" ? (raw(v) as number) : Number(String(raw(v) ?? "").replace(/[₱,\s]/g, ""));
  return Number.isFinite(n) && n > 0 ? Math.round(n * 100) : null;
};

const wb = new ExcelJS.Workbook();
await wb.xlsx.readFile(file);
const sheet = wb.worksheets[0];
const fileHash = createHash("sha256").update(readFileSync(file)).digest("hex").slice(0, 8);

interface Row { n: number; date: string; category: CostCategory; amount: number; description: string; dateGuessed: boolean }
const rows: Row[] = [];
interface IncomeRow { n: number; date: string; client: string; amount: number; note: string }
const incomeRows: IncomeRow[] = [];
const skipped = { income: [] as { n: number; amount: number }[], unknownCategory: [] as number[], badAmount: [] as number[] };
const readFromDescription: { n: number; was: string; description: string; category: string }[] = [];
let lastDate: string | null = null;
sheet.eachRow({ includeEmpty: false }, (row, n) => {
  const v = row.values as unknown[];
  const type = String(raw(v[2]) ?? "").trim().toLowerCase();
  const catName = String(raw(v[3]) ?? "").trim().toLowerCase();
  const amount = centavos(v[4]);
  const description = String(raw(v[5]) ?? "").trim();
  const d = raw(v[1]);
  const date = d instanceof Date ? d.toISOString().slice(0, 10) : null;
  if (date) lastDate = date;
  if (type === "income") {
    // Income is recorded under the client's name, which the sheet keeps in the Category column.
    if (amount === null || !date || !catName) return void skipped.badAmount.push(n);
    return void incomeRows.push({ n, date, client: String(raw(v[3])).trim(), amount, note: description });
  }
  if (type !== "expense") return void skipped.badAmount.push(n);
  // A category the sheet does not use for costs (a customer code, say) is read from the description instead.
  const fromDescription: CostCategory = /^diesel( |$)/i.test(description) ? "diesel" : /^(rfid|easytrip|autosweep)( |$)/i.test(description) ? "rfid" : "other";
  // When the description plainly says DIESEL or RFID, that decides the category, even if the Category column says otherwise.
  const named: CostCategory | null = /^diesel( |$)/i.test(description) ? "diesel" : /^rfid( |$)/i.test(description) ? "rfid" : null;
  // Toll payments (Passway, PassThru, or the word toll) sit under Others in the sheet but are Toll costs.
  const toll = !named && /(^| )(passway|passthru|toll|tollgate)( |$)/i.test(description) && catName !== "salary";
  const category: CostCategory = named ?? (toll ? "toll" : CATEGORY[catName] ?? fromDescription);
  if (!CATEGORY[catName] || (named && named !== CATEGORY[catName]) || (toll && CATEGORY[catName] !== "toll")) readFromDescription.push({ n, was: String(raw(v[3]) ?? ""), description, category });
  if (amount === null) return void skipped.badAmount.push(n);
  // A row with no date takes the date of the row above it, and is reported so it can be checked.
  rows.push({ n, date: date ?? lastDate ?? "", category, amount, description, dateGuessed: !date });
});
if (rows.some((r) => !r.date)) throw new Error("A row at the top has no date and no row above it to take one from.");

const sum = (list: Row[]) => list.reduce((a, r) => a + r.amount, 0);
const byCategory = new Map<string, Row[]>();
for (const r of rows) byCategory.set(r.category, [...(byCategory.get(r.category) ?? []), r]);
console.log(`\nFile: ${file}\nExpense rows to import: ${rows.length}  (${formatPeso(sum(rows))})`);
for (const [c, list] of [...byCategory].sort((a, b) => sum(b[1]) - sum(a[1]))) console.log(`  ${c.padEnd(12)} ${String(list.length).padStart(5)}  ${formatPeso(sum(list))}`);
{
  const byClient = new Map<string, IncomeRow[]>();
  for (const r of incomeRows) byClient.set(r.client, [...(byClient.get(r.client) ?? []), r]);
  console.log(`Income rows (money received): ${incomeRows.length}  (${formatPeso(incomeRows.reduce((a, r) => a + r.amount, 0))})`);
  for (const [c, list] of byClient) console.log(`  client ${c}: ${list.length} payments  ${formatPeso(list.reduce((a, r) => a + r.amount, 0))}`);
  const seen = new Set<string>();
  for (const r of incomeRows) {
    const k = `${r.date}|${r.client}|${r.amount}`;
    if (seen.has(k)) console.log(`  Same client, date and amount appear twice (row ${r.n}): ${r.date} ${formatPeso(r.amount)}. Both are imported; check the sheet.`);
    seen.add(k);
  }
}
for (const r of readFromDescription) console.log(`Category "${r.was}" on row ${r.n} ("${r.description}"): recorded as ${r.category} from the description`);
if (skipped.badAmount.length) console.log(`Unreadable amount or type, skipped rows: ${skipped.badAmount.join(", ")}`);
for (const r of rows.filter((x) => x.dateGuessed)) console.log(`No date on row ${r.n} ("${r.description}"): used ${r.date} from the row above`);

if (dryRun) {
  console.log("\nDry run: nothing was written.");
  process.exit(0);
}

const { sql, db } = adminClient();
const [u] = await db.select().from(users).where(eq(users.email, ownerEmail));
if (!u) throw new Error(`No user with email ${ownerEmail}`);
const [m] = await db
  .select({ tenantId: memberships.tenantId, role: memberships.role, kind: tenants.kind })
  .from(memberships)
  .innerJoin(tenants, eq(tenants.id, memberships.tenantId))
  .where(and(eq(memberships.userId, u.id), eq(tenants.kind, "hauler"), eq(memberships.role, "owner")));
if (!m) throw new Error(`${ownerEmail} is not the owner of a trucking company`);
const actor = { userId: u.id, tenantId: m.tenantId, tenantKind: m.kind, role: m.role, isPlatformAdmin: u.isPlatformAdmin };
// --- trucks: plates named on the command line are added to the fleet when missing ---
const flag = (name: string) => (args.indexOf(name) >= 0 ? args[args.indexOf(name) + 1] : undefined);
if (flag("--create-trucks")) {
  const type = (flag("--truck-type") ?? "6-wheeler") as "6-wheeler";
  const capacityKg = Number(flag("--capacity") ?? 6000);
  const have = new Set((await db.select({ p: trucks.plate }).from(trucks).where(eq(trucks.tenantId, m.tenantId))).map((t) => t.p.toUpperCase()));
  for (const plate of flag("--create-trucks")!.split(",").map((p) => p.trim().toUpperCase()).filter(Boolean)) {
    if (have.has(plate)) continue;
    await addTruck(actor, { plate, truckType: type, capacityKg, bodySize: flag("--size") });
    console.log(`Added truck ${plate} (${type}${flag("--size") ? `, ${flag("--size")}` : ""}, ${capacityKg} kg)`);
  }
}
const truckIds = new Map((await db.select({ id: trucks.id, plate: trucks.plate }).from(trucks).where(eq(trucks.tenantId, m.tenantId))).map((t) => [t.plate.toUpperCase(), t.id]));
const plateOf = (description: string) => description.toUpperCase().split(/[^A-Z0-9]+/).find((t) => truckIds.has(t));

// --- clear what an earlier run of this importer recorded (local test database only) ---
if (args.includes("--wipe-previous-import")) {
  const host = new URL(process.env.DATABASE_ADMIN_URL ?? "").hostname;
  if (host !== "localhost" && host !== "127.0.0.1") throw new Error("--wipe-previous-import only works on a database on this computer. A live ledger is never cleared; void entries instead.");
  await sql.begin(async (tx) => {
    await tx.unsafe("ALTER TABLE company_expenses DISABLE TRIGGER company_expenses_guard");
    const gone = await tx`delete from company_expenses where tenant_id = ${m.tenantId} and idempotency_key like 'xlsx-import:%' returning id`;
    await tx.unsafe("ALTER TABLE company_expenses ENABLE TRIGGER company_expenses_guard");
    console.log(`Cleared ${gone.length} entries from an earlier run of this import.`);
  });
}

// What an earlier run of this importer already recorded, so a corrected category can replace a wrong one.
const earlier = new Map(
  (await db.select({ id: companyExpenses.id, key: companyExpenses.idempotencyKey, category: companyExpenses.category, voidedAt: companyExpenses.voidedAt }).from(companyExpenses).where(and(eq(companyExpenses.tenantId, m.tenantId), like(companyExpenses.idempotencyKey, `xlsx-import:${fileHash}:%`)))).map((e) => [e.key, e]),
);
await sql.end();

// --- income: one client record per name, then one entry per payment ---
{
  const { sql: sql2, db: db2 } = adminClient();
  const names = [...new Set(incomeRows.map((r) => r.client))];
  const ids = new Map<string, string>();
  for (const name of names) {
    const [found] = await db2.select({ id: customers.id }).from(customers).where(and(eq(customers.tenantId, m.tenantId), ilike(customers.name, name)));
    if (found) ids.set(name, found.id);
    else {
      const [c] = await db2.insert(customers).values({ tenantId: m.tenantId, name }).returning({ id: customers.id });
      ids.set(name, c.id);
      console.log(`Created client "${name}"`);
    }
  }
  await sql2.end();
  let inc = 0;
  let incAlready = 0;
  for (const r of incomeRows) {
    const res = await addIncome(actor, { customerId: ids.get(r.client)!, amountCentavos: r.amount, receivedOn: r.date, note: r.note.slice(0, 500) || undefined, idempotencyKey: `xlsx-import:${fileHash}:income${r.n}` });
    if (res.duplicate) incAlready++;
    else inc++;
  }
  console.log(`Income: added ${inc}${incAlready ? `, already there ${incAlready}` : ""}.`);
}
if (incomeOnly) {
  await sql.end();
  await closeDb();
  process.exit(0);
}

let added = 0;
let already = 0;
let corrected = 0;
for (const r of rows) {
  const baseKey = `xlsx-import:${fileHash}:row${r.n}`;
  const before = earlier.get(baseKey);
  let key = baseKey;
  if (before && before.category !== r.category && !before.voidedAt) {
    // Recorded earlier under a different category: costs are never edited, so void it with the reason and add the right one.
    await voidCost(actor, before.id, "Category corrected to match the description (spreadsheet import)");
    corrected++;
    key = `${baseKey}:fix`;
  } else if (before && before.voidedAt) {
    key = `${baseKey}:fix`;
  }
  const res = await addCost(actor, {
    category: r.category,
    amountCentavos: r.amount,
    incurredOn: r.date,
    // A salary row's description is the person paid; for everything else it is what the cost was.
    payee: r.category === "salary" ? r.description.slice(0, 200) || undefined : undefined,
    note: r.category === "salary" ? undefined : r.description.slice(0, 500) || undefined,
    // The truck is named by its plate in the description (CCB, KAS, TYV, XJP). Salaries are people, not trucks.
    truckId: r.category === "salary" ? undefined : truckIds.get(plateOf(r.description) ?? ""),
    idempotencyKey: key,
  });
  if (res.duplicate) already++;
  else added++;
  if ((added + already) % 200 === 0) console.log(`  ...${added + already} of ${rows.length}`);
}
console.log(`\nDone. Added ${added}${already ? `, already there ${already}` : ""}${corrected ? `, corrected ${corrected} earlier entries` : ""}.`);
await closeDb();
