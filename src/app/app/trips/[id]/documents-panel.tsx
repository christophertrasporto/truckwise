import type { ChecklistView } from "@/server/services/documents";
import { formatDateTime } from "@/shared/format";
import { AddTripDocument, RemoveDocument, ReviewDocument, UploadDocument, WaiveDocument } from "./document-actions";

const STATE: Record<string, { label: string; tone: string }> = {
  missing: { label: "Needed", tone: "chip chip-bad" },
  pending: { label: "Awaiting review", tone: "chip chip-warn" },
  approved: { label: "Approved", tone: "chip chip-ok" },
  rejected: { label: "Rejected: send again", tone: "chip chip-bad" },
  waived: { label: "Not needed", tone: "chip" },
};

/** The client's required paperwork for this trip. Shown to staff and to the driver; controls follow what each may do. */
export function DocumentsPanel({ tripId, view }: { tripId: string; view: ChecklistView }) {
  if (view.items.length === 0 && !view.canManage) return null;
  const closed = view.tripStatus === "ready_for_invoice" || view.tripStatus === "cancelled";
  return (
    <section className="panel stack" aria-label="Documents for this client">
      <h2>Documents needed</h2>
      {view.outstanding.length > 0 && view.tripStatus !== "created" && (
        <div className="notice" role="status">
          {view.tripStatus === "pod_submitted" || view.tripStatus === "arrived_destination" || view.tripStatus === "delivery_exception"
            ? `The trip can be billed once these are approved: ${view.outstanding.join(", ")}.`
            : `Still to come after delivery: ${view.outstanding.join(", ")}.`}
        </div>
      )}
      {view.items.length === 0 && <p className="muted">No documents are set up for this trip.</p>}
      {view.items.map((i) => {
        const s = STATE[i.state];
        return (
          <div key={i.id} className="stack" style={{ borderTop: "1px solid var(--line)", paddingTop: 12 }}>
            <div style={{ display: "flex", justifyContent: "space-between", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
              <div>
                <b>{i.name}</b> <span className="muted">{i.required ? "Required" : "Optional"}{i.uploader === "dispatcher" ? " · dispatch uploads" : i.uploader === "driver" ? " · driver uploads" : ""}</span>
                {i.instructions && <div className="muted">{i.instructions}</div>}
              </div>
              <span className={s.tone}>{s.label}</span>
            </div>
            {i.latest && (
              <div className="muted">
                <a href={i.latest.url} target="_blank" rel="noreferrer">{i.latest.filename}</a> (version {i.latest.version}, {formatDateTime(i.latest.uploadedAt)})
                {i.latest.reviewNote && i.state === "rejected" ? `. Reason: ${i.latest.reviewNote}` : ""}
              </div>
            )}
            {i.state === "waived" && i.waiveReason && <div className="muted">Reason: {i.waiveReason}</div>}
            <div className="actions">
              {i.canUpload && <UploadDocument tripId={tripId} docId={i.id} label={i.name} />}
              {view.canReview && i.state === "pending" && i.latest && <ReviewDocument fileId={i.latest.id} />}
              {view.canManage && !closed && i.state !== "waived" && i.state !== "approved" && i.required && <WaiveDocument docId={i.id} />}
              {view.canReview && !closed && i.state !== "approved" && <RemoveDocument docId={i.id} />}
            </div>
          </div>
        );
      })}
      {view.canReview && !closed && <AddTripDocument tripId={tripId} />}
    </section>
  );
}
