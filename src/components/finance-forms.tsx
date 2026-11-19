"use client";

import { useRouter } from "next/navigation";
import { useRef, useState, type FormEvent } from "react";
import { post } from "@/components/api";
import { formatPeso, pesosToCentavos } from "@/shared/format";

/** Run a POST/PATCH and refresh the page. Keeps busy/error state for the form that owns it. */
function useSend() {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  async function send<T = unknown>(url: string, body: unknown, method: "POST" | "PATCH" = "POST", then?: (data: T) => void) {
    setBusy(true);
    setError(null);
    let res: { ok: boolean; data: T | null; error: string | null };
    if (method === "POST") res = await post<T>(url, body);
    else {
      try {
        const r = await fetch(url, { method, headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
        const json = await r.json().catch(() => null);
        res = r.ok ? { ok: true, data: json as T, error: null } : { ok: false, data: null, error: json?.error ?? "Something went wrong" };
      } catch {
        res = { ok: false, data: null, error: "Cannot reach the server." };
      }
    }
    setBusy(false);
    if (!res.ok) {
      setError(res.error);
      return false;
    }
    if (then) then(res.data as T);
    else router.refresh();
    return true;
  }
  return { send, busy, error };
}

interface ReadyTrip {
  id: string;
  reference: string;
  route: string;
  amountCentavos: number;
}

/**
 * One client's (or one subcontractor's) finished trips with checkboxes. The idempotency key is made once per
 * form, so pressing the button twice, or retrying after a dropped connection, can never create a second document.
 */
export function ReadyGroup({
  kind,
  partyId,
  partyName,
  trips,
}: {
  kind: "invoice" | "settlement";
  partyId: string;
  partyName: string;
  trips: ReadyTrip[];
}) {
  const router = useRouter();
  const key = useRef(crypto.randomUUID());
  const [picked, setPicked] = useState<string[]>(trips.map((t) => t.id));
  const { send, busy, error } = useSend();
  const total = trips.filter((t) => picked.includes(t.id)).reduce((n, t) => n + t.amountCentavos, 0);
  const url = kind === "invoice" ? "/api/invoices" : "/api/settlements";

  return (
    <section className="panel stack" aria-label={`${kind === "invoice" ? "Ready to invoice" : "Ready to settle"}: ${partyName}`}>
      <h2>{partyName}</h2>
      {error && <div className="alert" role="alert">{error}</div>}
      <div className="stack" style={{ gap: 6 }}>
        {trips.map((t) => (
          <label className="check" key={t.id}>
            <input type="checkbox" checked={picked.includes(t.id)} onChange={(e) => setPicked((p) => (e.target.checked ? [...p, t.id] : p.filter((x) => x !== t.id)))} />
            <span>
              <b className="mono">{t.reference}</b> {t.route} · {formatPeso(t.amountCentavos)}
            </span>
          </label>
        ))}
      </div>
      <div className="actions">
        <button
          className="btn btn-primary"
          disabled={busy || picked.length === 0}
          onClick={() =>
            send<{ id: string }>(
              url,
              kind === "invoice" ? { customerId: partyId, tripIds: picked, idempotencyKey: key.current } : { partnerTenantId: partyId, tripIds: picked, idempotencyKey: key.current },
              "POST",
              (d) => router.push(`${kind === "invoice" ? "/app/invoices" : "/app/settlements"}/${d.id}`),
            )
          }
        >
          {busy ? "Working…" : kind === "invoice" ? `Issue invoice (${formatPeso(total)})` : `Create settlement (${formatPeso(total)})`}
        </button>
      </div>
    </section>
  );
}

export function PayForm({ kind, id }: { kind: "invoice" | "settlement"; id: string }) {
  const [reference, setReference] = useState("");
  const { send, busy, error } = useSend();
  return (
    <form
      className="panel stack"
      onSubmit={(e: FormEvent) => {
        e.preventDefault();
        void send(`/api/${kind === "invoice" ? "invoices" : "settlements"}/${id}/pay`, { reference });
      }}
    >
      <h2>Record payment</h2>
      {error && <div className="alert" role="alert">{error}</div>}
      <div className="field" style={{ margin: 0 }}>
        <label htmlFor={`ref-${id}`}>Payment reference (bank, GCash, cheque no.)</label>
        <input id={`ref-${id}`} className="input" value={reference} onChange={(e) => setReference(e.target.value)} required />
      </div>
      <div><button className="btn btn-primary" disabled={busy || !reference.trim()}>{busy ? "Saving…" : "Mark as paid"}</button></div>
    </form>
  );
}

export function VoidForm({ kind, id }: { kind: "invoice" | "settlement"; id: string }) {
  const [reason, setReason] = useState("");
  const { send, busy, error } = useSend();
  return (
    <div className="panel stack">
      <h2>Void this {kind}</h2>
      <p className="muted">Voiding keeps it on record and frees its trips to be {kind === "invoice" ? "billed" : "settled"} again. A paid one cannot be voided.</p>
      {error && <div className="alert" role="alert">{error}</div>}
      <div className="field" style={{ margin: 0 }}>
        <label htmlFor={`void-${id}`}>Reason</label>
        <input id={`void-${id}`} className="input" value={reason} onChange={(e) => setReason(e.target.value)} />
      </div>
      <div>
        <button className="btn btn-danger btn-sm" disabled={busy || reason.trim().length < 3} onClick={() => confirm(`Void this ${kind}?`) && send(`/api/${kind === "invoice" ? "invoices" : "settlements"}/${id}/void`, { reason })}>
          Void {kind}
        </button>
      </div>
    </div>
  );
}

export function ExpenseReviewRow({ id }: { id: string }) {
  const [bears, setBears] = useState<"default" | "company" | "operator">("default");
  const [note, setNote] = useState("");
  const { send, busy, error } = useSend();
  const approve = () => send(`/api/expenses/${id}/review`, { decision: "approve", ...(bears === "default" ? {} : { companyBears: bears === "company" }), note: note || undefined });
  return (
    <div className="stack" style={{ gap: 8 }}>
      {error && <div className="alert" role="alert">{error}</div>}
      <div className="grid-form two">
        <div className="field" style={{ margin: 0 }}>
          <label htmlFor={`bears-${id}`}>Who pays</label>
          <select id={`bears-${id}`} className="input" value={bears} onChange={(e) => setBears(e.target.value as typeof bears)}>
            <option value="default">Follow the trip terms (recommended)</option>
            <option value="company">The company pays</option>
            <option value="operator">The driver or operator pays</option>
          </select>
        </div>
        <div className="field" style={{ margin: 0 }}>
          <label htmlFor={`note-${id}`}>Note (required to reject)</label>
          <input id={`note-${id}`} className="input" value={note} onChange={(e) => setNote(e.target.value)} />
        </div>
      </div>
      <div className="actions">
        <button className="btn btn-primary btn-sm" disabled={busy} onClick={approve}>Approve</button>
        <button className="btn btn-danger btn-sm" disabled={busy || !note.trim()} onClick={() => send(`/api/expenses/${id}/review`, { decision: "reject", note })}>Reject</button>
      </div>
    </div>
  );
}

export function MoneyEditForm({ tripId, rate, payout, subPayout, helperPay }: { tripId: string; rate: number; payout: number; subPayout: number | null; helperPay: number }) {
  const [r, setR] = useState((rate / 100).toFixed(2));
  const [p, setP] = useState((payout / 100).toFixed(2));
  const [sp, setSp] = useState(subPayout === null ? "" : (subPayout / 100).toFixed(2));
  const [hp, setHp] = useState((helperPay / 100).toFixed(2));
  const [reason, setReason] = useState("");
  const { send, busy, error } = useSend();
  const rc = pesosToCentavos(r);
  const pc = pesosToCentavos(p);
  const sc = sp.trim() === "" ? null : pesosToCentavos(sp);
  const hc = hp.trim() === "" ? 0 : pesosToCentavos(hp);
  const subOk = sp.trim() === "" || sc !== null;
  const subChanged = subOk && sc !== subPayout;
  const helperChanged = hc !== null && hc !== helperPay;
  const valid = rc !== null && pc !== null && subOk && hc !== null && reason.trim().length >= 3 && (rc !== rate || pc !== payout || subChanged || helperChanged);
  return (
    <div className="stack" style={{ borderTop: "1px solid var(--line)", paddingTop: 14 }}>
      <h2 style={{ fontSize: 15 }}>Change the money on this trip</h2>
      {error && <div className="alert" role="alert">{error}</div>}
      <div className="grid-form two">
        <div className="field" style={{ margin: 0 }}>
          <label htmlFor="m-rate">Customer rate (PHP)</label>
          <input id="m-rate" className="input" inputMode="decimal" value={r} onChange={(e) => setR(e.target.value)} />
        </div>
        <div className="field" style={{ margin: 0 }}>
          <label htmlFor="m-payout">Driver pay (PHP)</label>
          <input id="m-payout" className="input" inputMode="decimal" value={p} onChange={(e) => setP(e.target.value)} />
        </div>
        <div className="field" style={{ margin: 0 }}>
          <label htmlFor="m-sub">Subcontractor rate (PHP, empty = same as driver pay)</label>
          <input id="m-sub" className="input" inputMode="decimal" value={sp} onChange={(e) => setSp(e.target.value)} />
        </div>
        <div className="field" style={{ margin: 0 }}>
          <label htmlFor="m-helper">Helper pay (PHP)</label>
          <input id="m-helper" className="input" inputMode="decimal" value={hp} onChange={(e) => setHp(e.target.value)} />
        </div>
        <div className="field span2" style={{ margin: 0 }}>
          <label htmlFor="m-reason">Reason (kept in the audit log with the old and new amounts)</label>
          <input id="m-reason" className="input" value={reason} onChange={(e) => setReason(e.target.value)} />
        </div>
      </div>
      <div>
        <button
          className="btn btn-ghost btn-sm"
          disabled={busy || !valid}
          onClick={() => send(`/api/trips/${tripId}/money`, { ...(rc !== rate ? { contractRateCentavos: rc } : {}), ...(pc !== payout ? { payoutCentavos: pc } : {}), ...(subChanged ? { subcontractorPayoutCentavos: sc } : {}), ...(helperChanged ? { helperPayCentavos: hc } : {}), reason }, "PATCH")}
        >
          Save change
        </button>
      </div>
    </div>
  );
}

/** Add an expense with a receipt photo. For a driver it goes to review; for office staff it counts at once. */
export function ExpenseForm({ tripId, staff }: { tripId: string; staff: boolean }) {
  const router = useRouter();
  const key = useRef(crypto.randomUUID());
  const [category, setCategory] = useState("fuel");
  const [amount, setAmount] = useState("");
  const [note, setNote] = useState("");
  const [when, setWhen] = useState(() => {
    const n = new Date();
    return new Date(n.getTime() - n.getTimezoneOffset() * 60_000).toISOString().slice(0, 16);
  });
  const [file, setFile] = useState<File | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setDone(false);
    const c = pesosToCentavos(amount);
    if (c === null || c === 0) return setError("Enter the amount, for example 1250 or 1,250.50.");
    if (!staff && !file) return setError("Take a photo of the receipt.");
    const fd = new FormData();
    fd.set("category", category);
    fd.set("amountCentavos", String(c));
    fd.set("incurredAt", new Date(when).toISOString());
    if (note) fd.set("note", note);
    fd.set("idempotencyKey", key.current);
    if (file) fd.set("receipt", file);
    setBusy(true);
    const res = await post(`/api/trips/${tripId}/expenses`, fd);
    setBusy(false);
    if (!res.ok) return setError(res.error);
    key.current = crypto.randomUUID();
    setAmount("");
    setNote("");
    setFile(null);
    setDone(true);
    router.refresh();
  }

  return (
    <form onSubmit={submit} className="stack" noValidate aria-label="Add an expense">
      {error && <div className="alert" role="alert">{error}</div>}
      {done && <div className="notice ok-note" role="status">{staff ? "Expense recorded." : "Sent for review. The office will confirm it."}</div>}
      <div className="grid-form two">
        <div className="field" style={{ margin: 0 }}>
          <label htmlFor="x-cat">Type</label>
          <select id="x-cat" className="input" value={category} onChange={(e) => setCategory(e.target.value)}>
            <option value="fuel">Fuel</option>
            <option value="toll">Toll</option>
            <option value="parking">Parking</option>
            <option value="loading">Loading or unloading</option>
            <option value="repair">Repair</option>
            <option value="other">Other</option>
          </select>
        </div>
        <div className="field" style={{ margin: 0 }}>
          <label htmlFor="x-amt">Amount (PHP)</label>
          <input id="x-amt" className="input" inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} required />
        </div>
        <div className="field" style={{ margin: 0 }}>
          <label htmlFor="x-when">When</label>
          <input id="x-when" className="input" type="datetime-local" value={when} onChange={(e) => setWhen(e.target.value)} />
        </div>
        <div className="field" style={{ margin: 0 }}>
          <label htmlFor="x-note">Note (optional)</label>
          <input id="x-note" className="input" value={note} onChange={(e) => setNote(e.target.value)} />
        </div>
        <div className="field span2" style={{ margin: 0 }}>
          <label htmlFor="x-receipt">Receipt photo{staff ? " (optional)" : ""}</label>
          <input id="x-receipt" className="input" style={{ paddingTop: 12 }} type="file" accept="image/*" capture="environment" onChange={(e) => setFile(e.target.files?.[0] ?? null)} />
        </div>
      </div>
      <div><button className="btn btn-primary" disabled={busy}>{busy ? "Sending…" : staff ? "Record expense" : "Send for review"}</button></div>
    </form>
  );
}
