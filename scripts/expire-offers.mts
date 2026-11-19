import { adminClient } from "../src/server/db/admin";
import { tenants } from "../src/server/db/schema";
import { sweepExpiredOffers } from "../src/server/services/offers";

/** Expires overdue offers for every hauler. Safe to run repeatedly (for example every minute from a scheduler). */
const { sql, db } = adminClient();
const rows = await db.select({ id: tenants.id, name: tenants.name }).from(tenants);
await sql.end();

let total = 0;
for (const t of rows) {
  const n = await sweepExpiredOffers(t.id);
  if (n > 0) console.log(`${t.name}: ${n} offer(s) expired`);
  total += n;
}
console.log(`done, ${total} offer(s) expired`);
process.exit(0);
