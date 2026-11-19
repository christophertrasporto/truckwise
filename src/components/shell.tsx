import Link from "next/link";
import { eq } from "drizzle-orm";
import { LogoutButton } from "@/app/app/logout-button";
import { requireSignedIn } from "@/server/auth/current";
import { withTenant } from "@/server/db";
import { tenants } from "@/server/db/schema";
import { can } from "@/server/policy";
import { unreadCount } from "@/server/notify/service";
import { Logo } from "./logo";
import { NotificationLink } from "./notification-link";

const roleLabel: Record<string, string> = {
  owner: "Owner",
  ops_manager: "Operations manager",
  dispatcher: "Dispatcher",
  accountant: "Accountant",
  driver: "Driver",
  sub_owner: "Subcontractor owner",
  sub_manager: "Subcontractor manager",
  sub_driver: "Subcontractor driver",
  client: "Client",
};

/** Signed-in frame: company, role, role-appropriate navigation. Reads the session, so render inside <Suspense>. */
export async function Shell({ children }: { children: React.ReactNode }) {
  const actor = await requireSignedIn();
  let companyName = "Platform administration";
  if (actor.tenantId) {
    const tenantId = actor.tenantId;
    const [t] = await withTenant(tenantId, actor.userId, (db) => db.select().from(tenants).where(eq(tenants.id, tenantId)));
    companyName = t?.name ?? companyName;
  }
  const isDriver = actor.role === "driver";
  const unread = actor.tenantId ? await unreadCount({ ...actor, tenantId: actor.tenantId }) : 0;
  return (
    <div className="shell">
      <a className="skip-link" href="#main">Skip to content</a>
      <header className="shell-bar">
        <div className="wrap">
          <div className="shell-in">
            <Logo href="/app" />
            <div className="who">
              <div>
                <b>{companyName}</b>
                <small>{actor.role ? roleLabel[actor.role] : "Super admin"}</small>
              </div>
              <LogoutButton />
            </div>
          </div>
          <nav className="shell-nav" aria-label="App">
            <Link href="/app">{isDriver ? "My trips" : "Trips"}</Link>
            {actor.tenantId && <NotificationLink initial={unread} />}
            {can(actor, "trip:create") && <Link href="/app/trips/new">New trip</Link>}
            {can(actor, "trip:read") && <Link href="/app/calendar">Calendar</Link>}
            {can(actor, "customer:read") && <Link href="/app/clients">Clients</Link>}
            {can(actor, "fleet:read") && <Link href="/app/fleet">Fleet</Link>}
            {actor.tenantKind === "hauler" && can(actor, "partner:read") && <Link href="/app/partners">Subcontractors</Link>}
            {actor.tenantKind === "hauler" && can(actor, "partner:read") && <Link href="/app/applications">Applications</Link>}
            {can(actor, "member:read") && <Link href="/app/team">Team</Link>}
            {can(actor, "finance:read") && <Link href="/app/invoices">Invoices</Link>}
            {(can(actor, "finance:read") || can(actor, "settlement:read_own")) && <Link href="/app/settlements">Settlements</Link>}
            {can(actor, "expense:review") && <Link href="/app/expenses">Expenses</Link>}
            {can(actor, "cost:read") && <Link href="/app/costs">Costs</Link>}
            {can(actor, "finance:read") && <Link href="/app/profit">Profit</Link>}
            {can(actor, "earnings:read") && <Link href="/app/earnings">Earnings</Link>}
            {can(actor, "settings:read") && <Link href="/app/settings">Settings</Link>}
            {actor.isPlatformAdmin && <Link href="/app/admin">Platform</Link>}
            <Link href="/app/account">Account</Link>
          </nav>
        </div>
      </header>
      <main id="main" tabIndex={-1} className="wrap shell-main">{children}</main>
    </div>
  );
}
