import type { Metadata } from "next";
import { asc } from "drizzle-orm";
import { requireTenant } from "@/server/auth/current";
import { withTenant } from "@/server/db";
import { customers } from "@/server/db/schema";
import { can } from "@/server/policy";
import { NewTripForm } from "./new-trip-form";

export const metadata: Metadata = { title: "New trip" };

export default async function NewTripPage() {
  const actor = await requireTenant();
  if (!can(actor, "trip:create")) return <div className="empty">Your role cannot create trips.</div>;
  const list = await withTenant(actor.tenantId, actor.userId, (db) =>
    db.select({ id: customers.id, name: customers.name }).from(customers).orderBy(asc(customers.name)),
  );
  return (
    <div className="stack">
      <div className="page-head">
        <h1>New trip</h1>
      </div>
      <NewTripForm customers={list} />
    </div>
  );
}
