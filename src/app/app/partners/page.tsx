import type { Metadata } from "next";
import Link from "next/link";
import { requireTenant } from "@/server/auth/current";
import { can } from "@/server/policy";
import { getApplyToken } from "@/server/services/applications";
import { listPartners } from "@/server/services/partners";
import { formatDateTime } from "@/shared/format";
import { ApplyLink } from "./apply-link";
import { PartnerForms, PartnerStatusButton } from "./partner-forms";

export const metadata: Metadata = { title: "Subcontractors" };

export default async function PartnersPage() {
  const actor = await requireTenant();
  if (actor.tenantKind !== "hauler" || !can(actor, "partner:read")) return <div className="empty">Your role does not include subcontractors.</div>;
  const partners = await listPartners(actor);
  const manage = can(actor, "partner:manage");
  const applyToken = manage ? await getApplyToken(actor) : null;
  return (
    <div className="stack">
      <div className="page-head">
        <h1>Subcontractors</h1>
        <div className="actions"><Link className="btn btn-ghost btn-sm" href="/app/applications">Applications</Link></div>
      </div>
      {applyToken && <ApplyLink token={applyToken} />}
      {partners.length === 0 ? (
        <div className="empty">No subcontractors yet.</div>
      ) : (
        <table className="table">
          <thead>
            <tr><th>Company</th><th>Status</th><th>Since</th>{manage && <th />}</tr>
          </thead>
          <tbody>
            {partners.map((p) => (
              <tr key={p.partnerTenantId}>
                <td>{p.name}</td>
                <td><span className={p.status === "approved" ? "chip chip-ok" : "chip chip-bad"}>{p.status}</span></td>
                <td>{formatDateTime(p.since)}</td>
                {manage && <td><PartnerStatusButton tenantId={p.partnerTenantId} next={p.status === "approved" ? "revoked" : "approved"} /></td>}
              </tr>
            ))}
          </tbody>
        </table>
      )}
      <p className="muted">Revoking a subcontractor stops new offers to them. Trips already assigned to them can still be completed.</p>
      {manage && <PartnerForms />}
    </div>
  );
}
