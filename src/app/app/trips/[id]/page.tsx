import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { StatusChip } from "@/components/trip-ui";
import { requireTenant } from "@/server/auth/current";
import { can } from "@/server/policy";
import { listPartners } from "@/server/services/partners";
import { ExpenseForm, MoneyEditForm } from "@/components/finance-forms";
import { listMyTripExpenses } from "@/server/services/finance/expenses";
import { tripFinancials } from "@/server/services/finance/profit";
import { getTripForDriver, getTripForStaff } from "@/server/services/trip-detail";
import { listActiveDrivers } from "@/server/services/trips";
import { formatDateTime, formatPeso } from "@/shared/format";
import { expenseStatusLabel } from "./expense-labels";
import { tripStatusLabel } from "@/shared/state-machines/trip";
import { AcceptPanel, AdvanceButton, WithdrawRequest } from "./driver-panels";
import { getChecklist } from "@/server/services/documents";
import { DocumentsPanel } from "./documents-panel";
import { PodForm } from "./pod-form";
import { ApplicationActions, CancelOfferButton, CancelTripButton, OfferPanel, ReassignPanel, ReviewPanel } from "./staff-panels";

export const metadata: Metadata = { title: "Trip" };

type Stops = { id: string; seq: number; kind: string; address: string; requiredArrivalAt: string | null }[];
type Proof = Awaited<ReturnType<typeof getTripForStaff>>["proof"];

export function StopsList({ stops }: { stops: Stops }) {
  return (
    <ol className="stops">
      {stops.map((s) => (
        <li key={s.id}>
          <span className={`n ${s.kind}`}>{s.seq}</span>
          <div>
            <b>{s.kind === "pickup" ? "Pickup" : "Delivery"}</b>
            <div>{s.address}</div>
            <div className="muted">Required by {formatDateTime(s.requiredArrivalAt)}</div>
          </div>
        </li>
      ))}
    </ol>
  );
}

const outcomeLabel = { complete: "Complete delivery", partial: "Partial delivery", discrepancy: "Delivered with discrepancy", failed: "Delivery failed" } as const;
const proofTone = { pending: "chip chip-warn", approved: "chip chip-ok", rejected: "chip chip-bad", more_info_requested: "chip chip-warn" } as const;
const proofLabel = { pending: "Awaiting review", approved: "Approved", rejected: "Rejected", more_info_requested: "More proof requested" } as const;
const offerLabel: Record<string, string> = {
  broadcast_internal: "All our drivers",
  broadcast_partners: "Subcontractors",
  broadcast_all: "Drivers and subcontractors",
  selected: "Chosen drivers",
  direct: "Direct",
  applicants: "Open call",
};

function FileLink({ f }: { f: Proof[number]["photos"][number] }) {
  if (f.quarantined) {
    return (
      <div className="alert" style={{ margin: 0 }} role="alert">
        {f.filename}: quarantined. It failed the malware scan and cannot be opened.
      </div>
    );
  }
  return (
    <a href={f.url ?? "#"} target="_blank" rel="noreferrer" title={`${f.filename} (original)`}>
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img src={f.displayUrl ?? f.url ?? ""} alt={`Proof photo ${f.filename}`} loading="lazy" />
    </a>
  );
}

function ProofList({ proof, staff, canReview }: { proof: Proof; staff: boolean; canReview: boolean }) {
  if (proof.length === 0) return <p className="muted">No proof submitted yet.</p>;
  // Only the newest version of each stop can be reviewed.
  const newestPerStop = new Set<string>();
  const reviewable = new Set<string>();
  for (const p of proof) {
    const k = p.stopId ?? p.id;
    if (!newestPerStop.has(k)) {
      newestPerStop.add(k);
      if (p.status === "pending") reviewable.add(p.id);
    }
  }
  return (
    <div>
      {proof.map((p) => {
        const all = [...p.photos, ...(p.signature ? [p.signature] : []), ...p.pdfs];
        const quarantined = all.some((f) => f.quarantined);
        const scanning = all.some((f) => f.scan === "pending");
        return (
          <div className="proof" key={p.id}>
            <div className="row" style={{ display: "flex", justifyContent: "space-between", gap: 8, flexWrap: "wrap" }}>
              <b>{p.stopSeq ? `Stop ${p.stopSeq}` : "Delivery"}{p.stopAddress ? `, ${p.stopAddress}` : ""} · version {p.version}</b>
              <span className={proofTone[p.status]}>{proofLabel[p.status]}</span>
            </div>
            <dl className="kv">
              <div><dt>Outcome</dt><dd>{outcomeLabel[p.outcome]}</dd></div>
              <div><dt>Receiver</dt><dd>{p.receiverName}</dd></div>
              <div><dt>Delivered quantity</dt><dd>{p.deliveredQuantity ?? "-"}</dd></div>
              <div>
                <dt>Delivery time (driver-confirmed, unverified)</dt>
                <dd>{formatDateTime(p.actualDeliveryAt)}</dd>
              </div>
              <div><dt>Received by server</dt><dd>{formatDateTime(p.uploadedAt)}</dd></div>
              {p.submittedOffline && (
                <div>
                  <dt>Sent from the phone offline queue</dt>
                  <dd>{p.deviceQueuedAt ? `Phone clock said ${formatDateTime(p.deviceQueuedAt)} (device-reported, not verified)` : "Queue time not reported"}</dd>
                </div>
              )}
              <div>
                <dt>Location</dt>
                <dd>
                  {p.gps ? `${p.gps.lat.toFixed(5)}, ${p.gps.lng?.toFixed(5)} (±${Math.round(p.gps.accuracyM ?? 0)} m)` : p.gpsConsent === "denied" ? "Driver declined to share" : "Not provided"}
                </dd>
              </div>
              {staff && "driverName" in p && (
                <>
                  <div><dt>Assigned driver</dt><dd>{p.driverName}</dd></div>
                  <div>
                    <dt>Recorded by</dt>
                    <dd>{p.recordedByName}{p.submittedOnBehalf ? " (on the driver's behalf)" : ""}</dd>
                  </div>
                </>
              )}
            </dl>
            {p.discrepancyNotes && <div className="notice"><b>Discrepancy:</b> {p.discrepancyNotes}</div>}
            {p.comments && <p className="muted">{p.comments}</p>}
            {quarantined && <div className="alert" role="alert">A file in this proof failed the malware scan. It cannot be approved.</div>}
            {scanning && <p className="muted">Files are still being checked.</p>}
            <div className="photos">
              {p.photos.map((ph) => <FileLink key={ph.id} f={ph} />)}
            </div>
            {p.photos.some((ph) => ph.capturedAt) && (
              <p className="muted">Photo capture times are reported by the phone: {p.photos.filter((ph) => ph.capturedAt).map((ph) => formatDateTime(ph.capturedAt)).join(", ")}.</p>
            )}
            {p.photos.some((ph) => ph.capturedAt === null) && <p className="muted">Some photos carry no capture time (the phone did not report one).</p>}
            {p.signature && !p.signature.quarantined && (
              <div>
                <div className="muted">Receiver signature</div>
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src={p.signature.url ?? ""} alt="Receiver signature" style={{ maxWidth: 320, width: "100%", background: "#fff", border: "1px solid var(--line)", borderRadius: 10 }} />
              </div>
            )}
            {p.pdfs.map((f) => (
              <div key={f.id}>
                {f.quarantined ? <span className="muted">{f.filename}: quarantined</span> : <a href={f.url ?? "#"} target="_blank" rel="noreferrer" className="btn btn-ghost btn-sm">PDF receipt: {f.filename}</a>}
              </div>
            ))}
            {p.reviews.map((r, j) => (
              <div key={j} className="muted">
                {r.reviewerName}: <b>{r.decision.replace("_", " ")}</b>{r.reason ? ` - ${r.reason}` : ""} ({formatDateTime(r.at)})
              </div>
            ))}
            {canReview && reviewable.has(p.id) && !quarantined && <ReviewPanel submissionId={p.id} needsReason={p.outcome !== "complete"} />}
          </div>
        );
      })}
    </div>
  );
}

export default async function TripPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const actor = await requireTenant();

  if (actor.role === "driver" || actor.role === "sub_driver") {
    const d = await getTripForDriver(actor, id).catch(() => null);
    if (!d) notFound();
    const t = d.trip;
    const payout = d.money;
    const myExpenses = actor.role === "driver" && d.assignedToMe ? await listMyTripExpenses(actor, id) : null;
    const docs = d.assignedToMe ? await getChecklist(actor, id).catch(() => null) : null;
    return (
      <div className="stack">
        <div className="page-head">
          <div>
            <Link href="/app" className="muted">&larr; My trips</Link>
            <h1 className="mono">{t.reference}</h1>
          </div>
          <StatusChip status={t.status} />
        </div>
        {!d.assignedToMe && d.requested && <WithdrawRequest tripId={id} />}
        {!d.assignedToMe && !d.requested && <AcceptPanel tripId={id} direct={d.directOffer} />}
        {d.assignedToMe && d.nextStep && <AdvanceButton tripId={id} next={d.nextStep} />}
        {d.assignedToMe && d.stopProof.length > 0 && ["arrived_destination", "pod_submitted", "delivery_exception", "ready_for_invoice"].includes(t.status) && (
          <section className="panel stack" aria-label="Delivery stops">
            <h2>Delivery stops ({d.stopProof.filter((x) => x.state !== "needs_proof").length} of {d.stopProof.length} have proof)</h2>
            {d.stopProof.map((sp) => (
              <div key={sp.stopId} className="row" style={{ display: "flex", justifyContent: "space-between", gap: 8 }}>
                <span>Stop {sp.seq}: {sp.address}</span>
                <span className={sp.state === "approved" ? "chip chip-ok" : sp.state === "pending" ? "chip chip-warn" : "chip chip-bad"}>
                  {sp.state === "approved" ? "Approved" : sp.state === "pending" ? "Awaiting review" : sp.latest ? "Needs new proof" : "Proof needed"}
                </span>
              </div>
            ))}
          </section>
        )}
        {d.canSubmitProof &&
          d.stopProof
            .map((sp, i) => ({ sp, i }))
            .filter(({ sp }) => sp.state === "needs_proof")
            .map(({ sp, i }) => (
              <PodForm key={sp.stopId} tripId={id} tripRef={t.reference} stopId={sp.stopId} stopLabel={`delivery ${i + 1}`} expectedQuantity={d.stopProof.length === 1 ? t.quantity : null} allowPdf={d.allowPdf} />
            ))}
        {d.assignedToMe && t.status === "pod_submitted" && <div className="notice">Proof submitted. Dispatch will review it.</div>}
        {docs && <DocumentsPanel tripId={id} view={docs} />}
        {d.assignedToMe && t.status === "arrived_destination" && d.stopProof.some((x) => x.latest && x.latest.status !== "pending" && x.latest.status !== "approved") && <div className="notice">Dispatch asked for new proof on at least one stop. See the reason below.</div>}
        {d.assignedToMe && t.status === "delivery_exception" && <div className="notice">Reported as an exception. Dispatch is reviewing it.</div>}
        {t.status === "ready_for_invoice" && <div className="notice ok-note">Delivery approved. Thank you.</div>}
        <section className="panel">
          <h2>Trip details</h2>
          <dl className="kv">
            <div><dt>Client</dt><dd>{t.customerName}</dd></div>
            {payout && <div><dt>Your payout</dt><dd>{formatPeso(payout.payoutCentavos)}</dd></div>}
            {d.truckPlate && <div><dt>Your truck</dt><dd>{d.truckPlate}</dd></div>}
            <div><dt>Cargo</dt><dd>{t.cargoDescription}</dd></div>
            <div><dt>Truck needed</dt><dd>{t.truckRequirement ?? "Any"}</dd></div>
            <div><dt>Weight / quantity</dt><dd>{t.weightKg ?? "-"} kg / {t.quantity ?? "-"}</dd></div>
            {payout && <div><dt>Included in payout</dt><dd>{[payout.fuelIncluded && "Fuel", payout.tollIncluded && "Tolls"].filter(Boolean).join(", ") || "Neither fuel nor tolls"}</dd></div>}
            <div style={{ gridColumn: "1 / -1" }}><dt>Handling</dt><dd>{t.handlingInstructions ?? "-"}</dd></div>
          </dl>
        </section>
        <section className="panel">
          <h2>Route</h2>
          <StopsList stops={d.stops} />
        </section>
        {myExpenses && (
          <section className="panel stack" aria-labelledby="my-expenses">
            <h2 id="my-expenses">Expenses on this trip</h2>
            {myExpenses.length === 0 && <p className="muted">None reported. Add fuel, tolls or other costs with a photo of the receipt.</p>}
            {myExpenses.map((x) => (
              <div key={x.id} className="row" style={{ display: "flex", justifyContent: "space-between", gap: 8, flexWrap: "wrap" }}>
                <span>{x.category} · {formatPeso(x.amountCentavos)}</span>
                <span className={x.status === "approved" ? "chip chip-ok" : x.status === "rejected" ? "chip chip-bad" : "chip chip-warn"}>
                  {expenseStatusLabel(x.status, x.companyBears)}{x.reviewNote && x.status === "rejected" ? `: ${x.reviewNote}` : ""}
                </span>
              </div>
            ))}
            <ExpenseForm tripId={id} staff={false} />
          </section>
        )}
        {d.proof.length > 0 && (
          <section className="panel">
            <h2>Your proof</h2>
            <ProofList proof={d.proof as Proof} staff={false} canReview={false} />
          </section>
        )}
      </div>
    );
  }

  if (!can(actor, "trip:read")) notFound();
  const d = await getTripForStaff(actor, id).catch(() => null);
  if (!d) notFound();
  const t = d.trip;
  const canOffer = can(actor, "trip:offer") && (t.status === "created" || t.status === "offered");
  const [drivers, partners] = canOffer
    ? await Promise.all([listActiveDrivers(actor), listPartners(actor).then((p) => p.filter((x) => x.status === "approved").map((x) => ({ id: x.partnerTenantId, name: x.name })))])
    : [[], []];
  const fin = can(actor, "finance:read") ? await tripFinancials(actor, id).catch(() => null) : null;
  const docs = await getChecklist(actor, id).catch(() => null);
  const pendingApps = d.applications.filter((a) => a.status === "pending");
  const canReassign = can(actor, "trip:reassign") && !!d.driver && ["assigned", "started", "arrived_pickup"].includes(t.status);
  return (
    <div className="stack">
      <div className="page-head">
        <div>
          <Link href="/app" className="muted">&larr; All trips</Link>
          <h1 className="mono">{t.reference}</h1>
        </div>
        <StatusChip status={t.status} />
      </div>

      <section className="panel">
        <h2>Trip</h2>
        <dl className="kv">
          <div><dt>Client</dt><dd>{t.customerName}</dd></div>
          <div>
            <dt>Assigned to</dt>
            <dd>
              {d.driver ? `${d.driver.name}${d.driver.external ? ` (${d.driver.company})` : ""}${d.driver.truckPlate ? ` · ${d.driver.truckPlate}` : ""}` : "Not assigned"}
            </dd>
          </div>
          <div><dt>Cargo</dt><dd>{t.cargoDescription}</dd></div>
          <div><dt>Truck requirement</dt><dd>{t.truckRequirement ?? "Any"}</dd></div>
          {can(actor, "trip:view_rate") && <div><dt>Customer contract rate</dt><dd>{formatPeso(t.contractRateCentavos)}</dd></div>}
          <div><dt>Driver pay (own driver)</dt><dd>{formatPeso(t.payoutCentavos)}</dd></div>
          <div><dt>Subcontractor rate</dt><dd>{t.subcontractorPayoutCentavos != null ? formatPeso(t.subcontractorPayoutCentavos) : `Same as driver pay (${formatPeso(t.payoutCentavos)})`}</dd></div>
          {t.helperPayCentavos > 0 && <div><dt>Helper pay (own truck)</dt><dd>{formatPeso(t.helperPayCentavos)}</dd></div>}
          <div><dt>Fuel / tolls in payout</dt><dd>{t.fuelIncluded ? "Fuel" : "No fuel"} / {t.tollIncluded ? "Tolls" : "No tolls"}</dd></div>
          <div><dt>Weight / quantity</dt><dd>{t.weightKg ?? "-"} kg / {t.quantity ?? "-"}</dd></div>
          {t.handlingInstructions && <div style={{ gridColumn: "1 / -1" }}><dt>Handling</dt><dd>{t.handlingInstructions}</dd></div>}
          {t.notes && <div style={{ gridColumn: "1 / -1" }}><dt>Notes</dt><dd>{t.notes}</dd></div>}
        </dl>
        {canReassign && <ReassignPanel tripId={id} />}
      </section>

      <section className="panel">
        <h2>Route</h2>
        <StopsList stops={d.stops} />
      </section>

      {docs && <DocumentsPanel tripId={id} view={docs} />}

      {pendingApps.length > 0 && can(actor, "trip:offer") && (
        <section className="panel stack">
          <h2>Requests to take this trip ({pendingApps.length})</h2>
          {pendingApps.map((a) => (
            <div key={a.id} className="stack" style={{ borderTop: "1px solid var(--line)", paddingTop: 12 }}>
              <div>
                <b>{a.driverName}</b>{a.external ? ` · ${a.companyName}` : ""} · truck {a.truckPlate ?? "-"}
                <div className="muted">Requested {formatDateTime(a.createdAt)}</div>
              </div>
              <ApplicationActions applicationId={a.id} />
            </div>
          ))}
        </section>
      )}

      {canOffer && <OfferPanel tripId={id} drivers={drivers} partners={partners} hasOpenOffer={d.offers.some((o) => o.status === "open")} rateCentavos={can(actor, "trip:view_rate") ? t.contractRateCentavos : undefined} payoutCentavos={t.payoutCentavos} subPayoutCentavos={t.subcontractorPayoutCentavos} helperPayCentavos={t.helperPayCentavos} />}

      {d.offers.length > 0 && (
        <section className="panel">
          <h2>Offers</h2>
          <ol className="timeline">
            {d.offers.map((o) => (
              <li key={o.id}>
                <b>{offerLabel[o.mode] ?? o.mode}{o.partnerName ? `: ${o.partnerName}` : ""}</b> <span className="chip">{o.status}</span>{" "}
                {o.status === "open" && can(actor, "trip:offer") && <CancelOfferButton offerId={o.id} />}
                <small>
                  Sent {formatDateTime(o.createdAt)}{o.expiresAt ? ` · answer by ${formatDateTime(o.expiresAt)}` : ""}
                </small>
              </li>
            ))}
          </ol>
          {d.applications.filter((a) => a.status !== "pending").length > 0 && (
            <>
              <h2 style={{ marginTop: 18 }}>Past requests</h2>
              <ol className="timeline">
                {d.applications.filter((a) => a.status !== "pending").map((a) => (
                  <li key={a.id}>
                    <b>{a.driverName}</b>{a.external ? ` · ${a.companyName}` : ""} <span className="chip">{a.status}</span>
                    <small>{a.reason ?? ""} {formatDateTime(a.createdAt)}</small>
                  </li>
                ))}
              </ol>
            </>
          )}
        </section>
      )}

      <section className="panel">
        <h2>Proof of delivery</h2>
        <ProofList proof={d.proof} staff canReview={can(actor, "pod:review")} />
      </section>

      {fin && (
        <section className="panel stack" aria-labelledby="financials">
          <h2 id="financials">Money</h2>
          <dl className="kv">
            <div><dt>Customer charge</dt><dd>{formatPeso(fin.profit.revenueCentavos)}</dd></div>
            <div><dt>{fin.assignedTo === "partner" ? "Subcontractor payout" : "Driver pay"}</dt><dd>{fin.assignedTo ? formatPeso(fin.profit.partnerPayoutCentavos + fin.profit.driverPayCentavos) : "Not assigned yet"}</dd></div>
            {fin.profit.helperPayCentavos > 0 && <div><dt>Helper pay</dt><dd>{formatPeso(fin.profit.helperPayCentavos)}</dd></div>}
            <div><dt>Company-paid expenses</dt><dd>{formatPeso(fin.profit.directExpensesCentavos)}{fin.profit.pendingExpensesCentavos > 0 ? ` (+${formatPeso(fin.profit.pendingExpensesCentavos)} waiting for review)` : ""}</dd></div>
            <div><dt>Profit before overhead and taxes</dt><dd><b>{formatPeso(fin.profit.profitCentavos)}</b>{fin.profit.marginBps !== null ? ` (${(fin.profit.marginBps / 100).toFixed(1)}%)` : ""}{fin.profit.costsKnown ? "" : " (cost not final until assigned)"}</dd></div>
            <div>
              <dt>Billing</dt>
              <dd>
                {fin.invoice ? <Link href={`/app/invoices/${fin.invoice.id}`} className="mono">{fin.invoice.number} ({fin.invoice.status})</Link> : "Not invoiced"}
                {fin.settlement && <> · <Link href={`/app/settlements/${fin.settlement.id}`} className="mono">{fin.settlement.number} ({fin.settlement.status})</Link></>}
              </dd>
            </div>
          </dl>
          {fin.expenses.length > 0 && (
            <table className="table">
              <thead><tr><th>Expense</th><th>Amount</th><th>Status</th></tr></thead>
              <tbody>
                {fin.expenses.map((x) => (
                  <tr key={x.id}>
                    <td>{x.category}{x.note ? <div className="muted">{x.note}</div> : null}<div className="muted">{x.submittedByName}{x.receiptUrl ? <> · <a href={x.receiptUrl} target="_blank" rel="noreferrer">receipt</a></> : null}</div></td>
                    <td>{formatPeso(x.amountCentavos)}</td>
                    <td>{expenseStatusLabel(x.status, x.companyBears)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          {can(actor, "expense:add") && (
            <details>
              <summary style={{ cursor: "pointer", fontWeight: 600 }}>Add a company-paid expense</summary>
              <div style={{ marginTop: 12 }}><ExpenseForm tripId={id} staff /></div>
            </details>
          )}
          {can(actor, "money:edit") && t.status !== "cancelled" && <MoneyEditForm tripId={id} rate={t.contractRateCentavos} payout={t.payoutCentavos} subPayout={t.subcontractorPayoutCentavos} helperPay={t.helperPayCentavos} />}
        </section>
      )}
      {!fin && can(actor, "expense:add") && (
        <section className="panel stack">
          <h2>Add a company-paid expense</h2>
          <ExpenseForm tripId={id} staff />
        </section>
      )}

      <section className="panel">
        <h2>History</h2>
        <ol className="timeline">
          {d.timeline.map((e, i) => (
            <li key={i}>
              <b>{tripStatusLabel[e.to]}</b>
              <small>
                {formatDateTime(e.at)} by {e.actorName ?? "system"}{e.note ? `. ${e.note}` : ""}
              </small>
            </li>
          ))}
        </ol>
      </section>

      {can(actor, "trip:cancel") && !["ready_for_invoice", "cancelled"].includes(t.status) && <CancelTripButton tripId={id} />}
    </div>
  );
}
