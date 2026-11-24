/**
 * Marks an existing person as a platform administrator (gives them the Platform menu: companies, plans, subscriptions).
 *
 *   $env:DATABASE_ADMIN_URL = '<owner connection string>'
 *   $env:ADMIN_EMAIL = 'you@example.com'
 *   npm.cmd run db:make-admin:live
 *
 * The person must already have a login (create it with db:seed:live first). Safe to run twice.
 */
import { eq } from "drizzle-orm";
import { adminClient } from "../src/server/db/admin";
import { auditLog, users } from "../src/server/db/schema";

const email = process.env.ADMIN_EMAIL?.trim().toLowerCase();
if (!email) throw new Error("Set ADMIN_EMAIL to the person's login email.");

const { sql, db } = adminClient();
try {
  const [u] = await db.select().from(users).where(eq(users.email, email));
  if (!u) throw new Error(`No login with email ${email}. Create it first with: npm run db:seed:live`);
  if (u.isPlatformAdmin) {
    console.log(`${email} is already a platform administrator.`);
  } else {
    await db.update(users).set({ isPlatformAdmin: true }).where(eq(users.id, u.id));
    await db.insert(auditLog).values({ tenantId: null, actorUserId: null, action: "platform_admin.grant", entityType: "user", entityId: u.id, newValue: { email } });
    console.log(`${email} is now a platform administrator. Sign out and back in to see the Platform menu.`);
  }
} finally {
  await sql.end();
}
