"use client";

import { useRouter } from "next/navigation";
import { useRef, useState, type FormEvent } from "react";
import { post } from "@/components/api";
import { COST_CATEGORIES } from "@/shared/costs";
import { pesosToCentavos } from "@/shared/format";

export function CostForm({ trucks, canSalary }: { trucks: { id: string; plate: string }[]; canSalary: boolean }) {
  const router = useRouter();
  const key = useRef(crypto.randomUUID());
  const today = () => new Date(Date.now() + 8 * 3600_000).toISOString().slice(0, 10);
  const [category, setCategory] = useState("diesel");
  const [amount, setAmount] = useState("");
  const [on, setOn] = useState(today);
  const [payee, setPayee] = useState("");
  const [note, setNote] = useState("");
  const [truckId, setTruckId] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);
  const [busy, setBusy] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setDone(false);
    const c = pesosToCentavos(amount);
    if (c === null || c === 0) return setError("Enter the amount, for example 4500 or 4,500.50.");
    setBusy(true);
    const res = await post("/api/costs", { category, amountCentavos: c, incurredOn: on, payee: payee || undefined, note: note || undefined, truckId: truckId || undefined, idempotencyKey: key.current });
    setBusy(false);
    if (!res.ok) return setError(res.error);
    key.current = crypto.randomUUID();
    setAmount("");
    setNote("");
    setPayee("");
    setDone(true);
    router.refresh();
  }

  return (
    <form onSubmit={submit} className="panel stack" noValidate aria-label="Add a cost">
      <h2>Add a cost</h2>
      {error && <div className="alert" role="alert">{error}</div>}
      {done && <div className="notice ok-note" role="status">Cost recorded.</div>}
      <div className="grid-form two">
        <div className="field" style={{ margin: 0 }}>
          <label htmlFor="c-cat">Type</label>
          <select id="c-cat" className="input" value={category} onChange={(e) => setCategory(e.target.value)}>
            {COST_CATEGORIES.filter((c) => c.key !== "salary" || canSalary).map((c) => (
              <option key={c.key} value={c.key}>{c.label}</option>
            ))}
          </select>
        </div>
        <div className="field" style={{ margin: 0 }}>
          <label htmlFor="c-amt">Amount (PHP)</label>
          <input id="c-amt" className="input" inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} required />
        </div>
        <div className="field" style={{ margin: 0 }}>
          <label htmlFor="c-date">Date</label>
          <input id="c-date" className="input" type="date" value={on} onChange={(e) => setOn(e.target.value)} required />
        </div>
        <div className="field" style={{ margin: 0 }}>
          <label htmlFor="c-truck">Truck (optional)</label>
          <select id="c-truck" className="input" value={truckId} onChange={(e) => setTruckId(e.target.value)}>
            <option value="">Not for one truck</option>
            {trucks.map((t) => <option key={t.id} value={t.id}>{t.plate}</option>)}
          </select>
        </div>
        <div className="field" style={{ margin: 0 }}>
          <label htmlFor="c-payee">Paid to (optional)</label>
          <input id="c-payee" className="input" placeholder="Station, shop or employee" value={payee} onChange={(e) => setPayee(e.target.value)} />
        </div>
        <div className="field" style={{ margin: 0 }}>
          <label htmlFor="c-note">Note (optional)</label>
          <input id="c-note" className="input" value={note} onChange={(e) => setNote(e.target.value)} />
        </div>
      </div>
      <div><button className="btn btn-primary" disabled={busy}>{busy ? "Saving…" : "Record cost"}</button></div>
    </form>
  );
}

export function VoidCostButton({ id }: { id: string }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  return (
    <button
      className="btn btn-danger btn-sm"
      disabled={busy}
      onClick={async () => {
        const reason = prompt("Why is this cost being voided? (it stays on record, struck through)");
        if (!reason || reason.trim().length < 3) return;
        setBusy(true);
        await post(`/api/costs/${id}/void`, { reason });
        setBusy(false);
        router.refresh();
      }}
    >
      Void
    </button>
  );
}
