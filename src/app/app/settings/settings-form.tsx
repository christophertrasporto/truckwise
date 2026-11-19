"use client";

import { useRouter } from "next/navigation";
import { useState, type FormEvent } from "react";

interface Values {
  claimMode: "immediate" | "approval_required";
  podAutoApprove: boolean;
  allowPdfReceipts: boolean;
  vatBps: number;
}

export function SettingsForm({ initial, canEdit }: { initial: Values; canEdit: boolean }) {
  const router = useRouter();
  const [v, setV] = useState(initial);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [busy, setBusy] = useState(false);
  const [vat, setVat] = useState(String(initial.vatBps / 100));

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    setSaved(false);
    try {
      const res = await fetch("/api/settings", { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ ...v, vatBps: Math.round(Number(vat) * 100) }) });
      if (!res.ok) setError((await res.json().catch(() => null))?.error ?? "Could not save");
      else {
        setSaved(true);
        router.refresh();
      }
    } catch {
      setError("Cannot reach the server.");
    }
    setBusy(false);
  }

  return (
    <form onSubmit={submit} className="stack">
      {error && <div className="alert" role="alert">{error}</div>}
      {saved && <div className="notice ok-note" role="status">Saved.</div>}

      <section className="panel stack">
        <h2>When a driver or subcontractor accepts a trip</h2>
        <label className="check">
          <input type="radio" name="mode" checked={v.claimMode === "immediate"} disabled={!canEdit} onChange={() => setV({ ...v, claimMode: "immediate" })} />
          <span><b>Assign immediately.</b> The first eligible person to accept gets the trip.</span>
        </label>
        <label className="check">
          <input type="radio" name="mode" checked={v.claimMode === "approval_required"} disabled={!canEdit} onChange={() => setV({ ...v, claimMode: "approval_required" })} />
          <span><b>Dispatch approves first.</b> Accepting sends a request that you approve or decline on the trip.</span>
        </label>
        <p className="muted">Open calls (&quot;people apply, I pick&quot;) always need your approval, whatever this is set to.</p>
      </section>

      <section className="panel stack">
        <h2>Proof of delivery</h2>
        <label className="check">
          <input type="checkbox" name="auto" checked={v.podAutoApprove} disabled={!canEdit} onChange={(e) => setV({ ...v, podAutoApprove: e.target.checked })} />
          <span>
            <b>Approve clean, complete deliveries automatically.</b> Only when the delivery is complete, every file passed the
            malware scan, and there is a receiver signature or at least two photos. Partial, damaged or failed deliveries always
            wait for a person. Off by default.
          </span>
        </label>
        <label className="check">
          <input type="checkbox" name="pdf" checked={v.allowPdfReceipts} disabled={!canEdit} onChange={(e) => setV({ ...v, allowPdfReceipts: e.target.checked })} />
          <span><b>Let drivers attach a PDF receipt</b> (for example a scanned delivery receipt).</span>
        </label>
      </section>

      <section className="panel stack">
        <h2>Invoices</h2>
        <div className="field" style={{ margin: 0 }}>
          <label htmlFor="vat">VAT added to new invoices (%)</label>
          <input id="vat" className="input" inputMode="decimal" value={vat} disabled={!canEdit} onChange={(e) => setVat(e.target.value)} />
          <span className="muted">Use 12 if you charge VAT, or 0 if you do not. It is fixed on each invoice when it is issued.</span>
        </div>
      </section>

      {canEdit && <div><button className="btn btn-primary" disabled={busy}>{busy ? "Saving…" : "Save"}</button></div>}
    </form>
  );
}
