"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { post } from "@/components/api";
import { QuoteBox } from "@/components/quote-box";

function useAction() {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  async function run(url: string, body?: unknown) {
    setBusy(true);
    setError(null);
    const res = await post(url, body);
    setBusy(false);
    if (!res.ok) {
      setError(res.error);
      return false;
    }
    router.refresh();
    return true;
  }
  return { run, busy, error };
}

type Mode = "broadcast_internal" | "broadcast_partners" | "broadcast_all" | "selected" | "direct" | "applicants";

const modeText: Record<Mode, string> = {
  broadcast_internal: "All our drivers (first to accept)",
  broadcast_partners: "Approved subcontractors only",
  broadcast_all: "Our drivers and subcontractors",
  selected: "Chosen drivers only",
  direct: "One driver or one subcontractor",
  applicants: "Open call: people apply, I pick",
};

export function OfferPanel({
  tripId,
  drivers,
  partners,
  hasOpenOffer,
  rateCentavos,
  payoutCentavos,
  subPayoutCentavos,
  helperPayCentavos,
}: {
  tripId: string;
  drivers: { id: string; name: string }[];
  partners: { id: string; name: string }[];
  hasOpenOffer: boolean;
  rateCentavos?: number;
  payoutCentavos?: number;
  subPayoutCentavos?: number | null;
  helperPayCentavos?: number;
}) {
  const { run, busy, error } = useAction();
  const [mode, setMode] = useState<Mode>("broadcast_internal");
  const [audience, setAudience] = useState<"internal" | "partners" | "all">("all");
  const [target, setTarget] = useState(drivers[0] ? `d:${drivers[0].id}` : partners[0] ? `p:${partners[0].id}` : "");
  const [chosen, setChosen] = useState<string[]>([]);
  const [expires, setExpires] = useState("");

  const modes = (Object.keys(modeText) as Mode[]).filter((m) => (m === "broadcast_partners" || m === "broadcast_all" ? partners.length > 0 : true));

  function body() {
    const b: Record<string, unknown> = { mode };
    if (mode === "direct") {
      if (target.startsWith("d:")) b.driverUserId = target.slice(2);
      else b.partnerTenantId = target.slice(2);
    }
    if (mode === "selected") b.userIds = chosen;
    if (mode === "applicants") b.audience = audience;
    if (expires) b.expiresAt = new Date(expires).toISOString();
    return b;
  }
  const incomplete = (mode === "direct" && !target) || (mode === "selected" && chosen.length === 0);

  return (
    <section className="panel">
      <h2>{hasOpenOffer ? "Replace the open offer" : "Offer this trip"}</h2>
      {hasOpenOffer && <p className="muted" style={{ marginBottom: 12 }}>A new offer withdraws the current one and any requests on it.</p>}
      {rateCentavos !== undefined && payoutCentavos !== undefined && (
        <div style={{ marginBottom: 12 }}>
          <div className="stack">
            <QuoteBox customerPays={(rateCentavos / 100).toFixed(2)} offer={(payoutCentavos / 100).toFixed(2)} yourCosts={helperPayCentavos ? (helperPayCentavos / 100).toFixed(2) : undefined} who={subPayoutCentavos != null ? "your driver (and helper)" : undefined} />
            {subPayoutCentavos != null && <QuoteBox customerPays={(rateCentavos / 100).toFixed(2)} offer={(subPayoutCentavos / 100).toFixed(2)} who="the subcontractor" id="quote-box-sub" />}
          </div>
        </div>
      )}
      {error && <div className="alert" role="alert">{error}</div>}
      <div className="grid-form two">
        <div className="field">
          <label htmlFor="mode">Who can take it</label>
          <select id="mode" className="input" value={mode} onChange={(e) => setMode(e.target.value as Mode)}>
            {modes.map((m) => (
              <option key={m} value={m}>{modeText[m]}</option>
            ))}
          </select>
        </div>
        <div className="field">
          <label htmlFor="expires">Answer by (optional)</label>
          <input id="expires" className="input" type="datetime-local" value={expires} onChange={(e) => setExpires(e.target.value)} />
        </div>
        {mode === "applicants" && (
          <div className="field">
            <label htmlFor="aud">Who may apply</label>
            <select id="aud" className="input" value={audience} onChange={(e) => setAudience(e.target.value as typeof audience)}>
              <option value="internal">Our drivers</option>
              {partners.length > 0 && <option value="partners">Subcontractors</option>}
              {partners.length > 0 && <option value="all">Both</option>}
            </select>
          </div>
        )}
        {mode === "direct" && (
          <div className="field">
            <label htmlFor="target">Send to</label>
            <select id="target" className="input" value={target} onChange={(e) => setTarget(e.target.value)}>
              {drivers.map((d) => <option key={d.id} value={`d:${d.id}`}>Driver: {d.name}</option>)}
              {partners.map((p) => <option key={p.id} value={`p:${p.id}`}>Subcontractor: {p.name}</option>)}
            </select>
          </div>
        )}
        {mode === "selected" && (
          <fieldset className="field span2" style={{ border: 0, padding: 0, margin: 0 }}>
            <legend style={{ fontWeight: 600, fontSize: 14, marginBottom: 6 }}>Drivers</legend>
            {drivers.length === 0 && <p className="muted">No drivers yet. Add drivers on the Team page.</p>}
            {drivers.map((d) => (
              <label className="check" key={d.id}>
                <input type="checkbox" checked={chosen.includes(d.id)} onChange={(e) => setChosen((c) => (e.target.checked ? [...c, d.id] : c.filter((x) => x !== d.id)))} /> {d.name}
              </label>
            ))}
          </fieldset>
        )}
      </div>
      <div className="actions" style={{ marginTop: 14 }}>
        <button className="btn btn-primary" disabled={busy || incomplete} onClick={() => run(`/api/trips/${tripId}/offer`, body())}>
          {busy ? "Sending…" : "Send offer"}
        </button>
      </div>
    </section>
  );
}

export function CancelOfferButton({ offerId }: { offerId: string }) {
  const { run, busy, error } = useAction();
  return (
    <span>
      <button className="btn btn-danger btn-sm" disabled={busy} onClick={() => run(`/api/offers/${offerId}/cancel`)}>Withdraw</button>
      {error && <span className="muted"> {error}</span>}
    </span>
  );
}

export function ApplicationActions({ applicationId }: { applicationId: string }) {
  const { run, busy, error } = useAction();
  const [reason, setReason] = useState("");
  return (
    <div className="stack" style={{ gap: 8 }}>
      {error && <div className="alert" role="alert">{error}</div>}
      <input className="input" aria-label="Reason (optional)" placeholder="Reason (optional)" value={reason} onChange={(e) => setReason(e.target.value)} />
      <div className="actions">
        <button className="btn btn-primary btn-sm" disabled={busy} onClick={() => run(`/api/applications/${applicationId}/decide`, { decision: "approve", reason })}>Approve</button>
        <button className="btn btn-ghost btn-sm" disabled={busy} onClick={() => run(`/api/applications/${applicationId}/decide`, { decision: "decline", reason })}>Decline</button>
      </div>
    </div>
  );
}

export function ReassignPanel({ tripId }: { tripId: string }) {
  const { run, busy, error } = useAction();
  const [reason, setReason] = useState("");
  return (
    <div className="stack" style={{ borderTop: "1px solid var(--line)", paddingTop: 14 }}>
      {error && <div className="alert" role="alert">{error}</div>}
      <div className="field" style={{ margin: 0 }}>
        <label htmlFor="reassign-reason">Take the job back (before cargo is loaded)</label>
        <input id="reassign-reason" className="input" placeholder="Reason, for example driver unavailable" value={reason} onChange={(e) => setReason(e.target.value)} />
      </div>
      <div>
        <button className="btn btn-danger btn-sm" disabled={busy || reason.trim().length < 3} onClick={() => run(`/api/trips/${tripId}/reassign`, { reason })}>Reassign</button>
      </div>
    </div>
  );
}

export function CancelTripButton({ tripId }: { tripId: string }) {
  const { run, busy, error } = useAction();
  return (
    <div>
      {error && <div className="alert" role="alert">{error}</div>}
      <button
        className="btn btn-danger btn-sm"
        disabled={busy}
        onClick={() => {
          if (confirm("Cancel this trip? Open offers and the current assignment will be withdrawn.")) run(`/api/trips/${tripId}/cancel`);
        }}
      >
        Cancel trip
      </button>
    </div>
  );
}

export function ReviewPanel({ submissionId, needsReason }: { submissionId: string; needsReason: boolean }) {
  const { run, busy, error } = useAction();
  const [reason, setReason] = useState("");
  const send = (decision: "approve" | "reject" | "request_more") => run(`/api/pod/${submissionId}/review`, { decision, reason });
  return (
    <div className="stack" style={{ borderTop: "1px solid var(--line)", paddingTop: 14 }}>
      {error && <div className="alert" role="alert">{error}</div>}
      <div className="field" style={{ margin: 0 }}>
        <label htmlFor={`reason-${submissionId}`}>Reason {needsReason ? "(required to accept an exception)" : "(required to reject or ask for more)"}</label>
        <textarea id={`reason-${submissionId}`} className="input" value={reason} onChange={(e) => setReason(e.target.value)} />
      </div>
      <div className="actions">
        <button className="btn btn-primary" disabled={busy || (needsReason && !reason.trim())} onClick={() => send("approve")}>
          Approve
        </button>
        <button className="btn btn-ghost" disabled={busy || !reason.trim()} onClick={() => send("request_more")}>
          Request more proof
        </button>
        <button className="btn btn-danger" disabled={busy || !reason.trim()} onClick={() => send("reject")}>
          Reject
        </button>
      </div>
    </div>
  );
}
