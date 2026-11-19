import type { Metadata } from "next";
import { asc, desc } from "drizzle-orm";
import { requireTenant } from "@/server/auth/current";
import { withTenant } from "@/server/db";
import { customerDocumentTypes, customers } from "@/server/db/schema";
import { can } from "@/server/policy";
import { ClientForm } from "./client-form";
import { DocumentTypes } from "./document-types";

export const metadata: Metadata = { title: "Clients" };

export default async function ClientsPage() {
  const actor = await requireTenant();
  if (!can(actor, "customer:read")) return <div className="empty">Your role does not include clients.</div>;
  const [rows, types] = await withTenant(actor.tenantId, actor.userId, async (db) => [
    await db.select().from(customers).orderBy(desc(customers.createdAt)),
    await db.select().from(customerDocumentTypes).orderBy(asc(customerDocumentTypes.position), asc(customerDocumentTypes.createdAt)),
  ] as const);
  const canConfigure = can(actor, "document:configure");
  return (
    <div className="stack">
      <div className="page-head">
        <h1>Clients</h1>
      </div>
      {rows.length === 0 ? (
        <div className="empty">No clients yet. Add the first one below.</div>
      ) : (
        <table className="table">
          <thead>
            <tr>
              <th>Client</th>
              <th>Contact</th>
              <th>Address</th>
              <th>Documents per trip</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((c) => (
              <tr key={c.id}>
                <td>{c.name}</td>
                <td>{[c.contactName, c.contactPhone].filter(Boolean).join(", ") || "-"}</td>
                <td>{c.address ?? "-"}</td>
                <td style={{ minWidth: 260 }}>
                  <details>
                    <summary>{types.filter((t) => t.customerId === c.id && t.active).length} set up</summary>
                    <DocumentTypes customerId={c.id} customerName={c.name} types={types.filter((t) => t.customerId === c.id)} canEdit={canConfigure} />
                  </details>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {can(actor, "customer:write") && <ClientForm />}
    </div>
  );
}
