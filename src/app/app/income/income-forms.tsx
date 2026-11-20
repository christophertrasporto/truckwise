"use client";

import { useRouter } from "next/navigation";
import { useRef, useState, type FormEvent } from "react";
import { post } from "@/components/api";
import { pesosToCentavos } from "@/shared/format";

export function IncomeForm({ clients }: { clients: { id: string; name: string }[] }) {
  const router = useRouter();
  const key = useRef(crypto.randomUUID());
  const [today] = useState(() => new Date(Date.now() + 8 * 3600_000).toISOString().slice(0, 10));
  const [clientId, setClientId] = useState("");
  const [amount, setAmount] = useState("");
  const [on, setOn] = useState(today);
  const [note, setNote] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);
  const [busy, setBusy] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setDone(false);
    const c = pesosToCentavos(amount);
    if (!clientId) return setError("Choose the client who paid. Add the client on the Clients page if it is not listed.");
    if (c === null || c === 0) return setError("Enter the amount, for example 50000 or 50,000.50.");
    setBusy(true);
    const res = await post("/api/income", { customerId: clientId, amountCentavos: c, receivedOn: on, note: note || undefined, idempotencyKey: key.current });
    setBusy(false);
    if (!res.ok) return setError(res.error);
    key.current = crypto.randomUUID();
    setAmount("");
    setNote("");
    setDone(true);
    router.refresh();
  }

  return (
    <form onSubmit={submit} className="panel stack" noValidate aria-label="Record income">
      <h2>Record money received</h2>
      {error && <div className="alert" role="alert">{error}</div>}
      {done && <div className="notice ok-note" role="status">Income recorded.</div>}
      <div className="grid-form two">
        <div className="field" style={{ margin: 0 }}>
          <label htmlFor="i-client">Client</label>
          <select id="i-client" className="input" value={clientId} onChange={(e) => setClientId(e.target.value)}>
            <option value="">Choose a client</option>
            {clients.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
          </select>
        </div>
        <div className="field" style={{ margin: 0 }}>
          <label htmlFor="i-amt">Amount (PHP)</label>
          <input id="i-amt" className="input" inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} required />
        </div>
        <div className="field" style={{ margin: 0 }}>
          <label htmlFor="i-date">Date received</label>
          <input id="i-date" className="input" type="date" value={on} onChange={(e) => setOn(e.target.value)} required />
        </div>
        <div className="field" style={{ margin: 0 }}>
          <label htmlFor="i-note">Note (optional)</label>
          <input id="i-note" className="input" value={note} onChange={(e) => setNote(e.target.value)} placeholder="Weekly payment, check no..." />
        </div>
      </div>
      <div><button className="btn btn-primary" disabled={busy}>{busy ? "Saving…" : "Record income"}</button></div>
    </form>
  );
}

export function VoidIncomeButton({ id }: { id: string }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  return (
    <button
      className="btn btn-danger btn-sm"
      disabled={busy}
      onClick={async () => {
        const reason = prompt("Why is this entry being voided? (it stays on record, struck through)");
        if (!reason || reason.trim().length < 3) return;
        setBusy(true);
        await post(`/api/income/${id}/void`, { reason });
        setBusy(false);
        router.refresh();
      }}
    >
      Void
    </button>
  );
}
