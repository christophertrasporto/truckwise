import type { Metadata } from "next";
import Link from "next/link";
import { requireTenant } from "@/server/auth/current";
import { can } from "@/server/policy";
import { listApplications } from "@/server/services/applications";
import { formatDateTime } from "@/shared/format";

export const metadata: Metadata = { title: "Applications" };

export default async function ApplicationsPage() {
  const actor = await requireTenant();
  if (actor.tenantKind !== "hauler" || !can(actor, "partner:read")) return <div className="empty">Your role does not include subcontractor applications.</div>;
  const rows = await listApplications(actor);
  return (
    <div className="stack">
      <div className="page-head">
        <h1>Subcontractor applications</h1>
        <div className="actions"><Link className="btn btn-ghost btn-sm" href="/app/partners">Application link</Link></div>
      </div>
      {rows.length === 0 ? (
        <div className="empty">No applications yet. Share the application link from the Subcontractors page.</div>
      ) : (
        <div style={{ overflowX: "auto" }}>
          <table className="table" style={{ minWidth: 640 }}>
            <thead><tr><th>Company</th><th>Truck</th><th>Plate</th><th>Applied</th><th>Status</th></tr></thead>
            <tbody>
              {rows.map((a) => (
                <tr key={a.id}>
                  <td><Link href={`/app/applications/${a.id}`}>{a.companyName}</Link><div className="muted">{a.contactName} · {a.phone}</div></td>
                  <td>{a.truckCount > 1 ? `${a.truckCount} trucks` : `${a.truckType} ${a.truckSize}`}</td>
                  <td>{a.plateNumber}{a.truckCount > 1 ? ` +${a.truckCount - 1}` : ""}</td>
                  <td>{formatDateTime(a.createdAt)}</td>
                  <td><span className={a.status === "approved" ? "chip chip-ok" : a.status === "rejected" ? "chip chip-bad" : "chip chip-info"}>{a.status}</span></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
