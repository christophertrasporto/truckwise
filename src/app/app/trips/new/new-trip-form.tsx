"use client";

import { useRouter } from "next/navigation";
import { useState, type FormEvent } from "react";
import { post } from "@/components/api";
import { pesosToCentavos } from "@/shared/format";
import { QuoteBox } from "@/components/quote-box";
import { TRUCK_TYPES } from "@/shared/truck-types";

interface Stop {
  kind: "pickup" | "delivery";
  address: string;
  requiredAt: string; // datetime-local, device time zone
}

const blankStop = (kind: Stop["kind"]): Stop => ({ kind, address: "", requiredAt: "" });

/** Two peso amounts typed as text, added together as text again; an empty or invalid one counts as zero. */
function addPesos(a: string, b: string): string {
  const x = a.trim() === "" ? 0 : pesosToCentavos(a);
  const y = b.trim() === "" ? 0 : pesosToCentavos(b);
  if (x === null || y === null) return "";
  return ((x + y) / 100).toFixed(2);
}

export function NewTripForm({ customers }: { customers: { id: string; name: string }[] }) {
  const router = useRouter();
  const [f, setF] = useState({
    customerId: customers[0]?.id ?? "",
    reference: "",
    cargoDescription: "",
    cargoType: "",
    weightKg: "",
    quantity: "",
    truckRequirement: "",
    handlingInstructions: "",
    notes: "",
    contractRate: "",
    payout: "",
    subPayout: "",
    helperPay: "",
    fuelIncluded: false,
    tollIncluded: false,
  });
  const [estCosts, setEstCosts] = useState("");
  const [stops, setStops] = useState<Stop[]>([blankStop("pickup"), blankStop("delivery")]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const set = (k: keyof typeof f) => (e: { target: { value: string; type?: string; checked?: boolean } }) =>
    setF((p) => ({ ...p, [k]: e.target.type === "checkbox" ? e.target.checked : e.target.value }));
  const setStop = (i: number, patch: Partial<Stop>) => setStops((s) => s.map((x, j) => (j === i ? { ...x, ...patch } : x)));
  const move = (i: number, d: -1 | 1) =>
    setStops((s) => {
      const j = i + d;
      if (j < 0 || j >= s.length) return s;
      const c = [...s];
      [c[i], c[j]] = [c[j], c[i]];
      return c;
    });

  async function submit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    const contract = pesosToCentavos(f.contractRate);
    const payout = pesosToCentavos(f.payout);
    if (contract === null || payout === null) return setError("Enter the customer rate and the driver pay as amounts, for example 18500 or 18,500.50.");
    const sub = f.subPayout.trim() === "" ? undefined : pesosToCentavos(f.subPayout);
    const helper = f.helperPay.trim() === "" ? 0 : pesosToCentavos(f.helperPay);
    if (sub === null || helper === null) return setError("Enter the subcontractor rate and the helper pay as amounts, or leave them empty.");
    const num = (v: string) => (v.trim() === "" ? undefined : Number(v));
    setBusy(true);
    const res = await post<{ id: string }>("/api/trips", {
      customerId: f.customerId,
      reference: f.reference,
      cargoDescription: f.cargoDescription,
      cargoType: f.cargoType,
      weightKg: num(f.weightKg),
      quantity: num(f.quantity),
      truckRequirement: f.truckRequirement || undefined,
      handlingInstructions: f.handlingInstructions,
      notes: f.notes,
      contractRateCentavos: contract,
      payoutCentavos: payout,
      subcontractorPayoutCentavos: sub,
      helperPayCentavos: helper,
      fuelIncluded: f.fuelIncluded,
      tollIncluded: f.tollIncluded,
      stops: stops.map((s) => ({
        kind: s.kind,
        address: s.address,
        requiredArrivalAt: s.requiredAt ? new Date(s.requiredAt).toISOString() : undefined,
      })),
    });
    setBusy(false);
    if (!res.ok) return setError(res.error);
    router.push(`/app/trips/${res.data!.id}`);
  }

  if (customers.length === 0) {
    return <div className="notice">Add a client first. Go to Clients, then come back to create the trip.</div>;
  }

  return (
    <form onSubmit={submit} className="stack" noValidate>
      {error && (
        <div className="alert" role="alert">
          {error}
        </div>
      )}

      <section className="panel">
        <h2>Request</h2>
        <div className="grid-form two">
          <div className="field">
            <label htmlFor="customer">Client</label>
            <select id="customer" className="input" value={f.customerId} onChange={set("customerId")}>
              {customers.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </select>
          </div>
          <div className="field">
            <label htmlFor="reference">Trip reference</label>
            <input id="reference" className="input" value={f.reference} onChange={set("reference")} required />
          </div>
          <div className="field span2">
            <label htmlFor="cargo">Cargo description</label>
            <input id="cargo" className="input" value={f.cargoDescription} onChange={set("cargoDescription")} required />
          </div>
          <div className="field">
            <label htmlFor="ctype">Cargo type</label>
            <input id="ctype" className="input" value={f.cargoType} onChange={set("cargoType")} />
          </div>
          <div className="field">
            <label htmlFor="truck">Truck requirement</label>
            <select id="truck" className="input" value={f.truckRequirement} onChange={set("truckRequirement")}>
              <option value="">Any truck</option>
              {TRUCK_TYPES.map((x) => <option key={x}>{x}</option>)}
            </select>
          </div>
          <div className="field">
            <label htmlFor="weight">Weight (kg)</label>
            <input id="weight" className="input" inputMode="numeric" value={f.weightKg} onChange={set("weightKg")} />
          </div>
          <div className="field">
            <label htmlFor="qty">Quantity</label>
            <input id="qty" className="input" inputMode="numeric" value={f.quantity} onChange={set("quantity")} />
          </div>
          <div className="field span2">
            <label htmlFor="handling">Handling instructions</label>
            <textarea id="handling" className="input" value={f.handlingInstructions} onChange={set("handlingInstructions")} />
          </div>
          <div className="field span2">
            <label htmlFor="notes">Notes</label>
            <textarea id="notes" className="input" value={f.notes} onChange={set("notes")} />
          </div>
        </div>
      </section>

      <section className="panel">
        <h2>Stops</h2>
        <p className="muted" style={{ marginBottom: 12 }}>First stop is the pickup, last is the final delivery. Times are in your device time zone.</p>
        <div className="stack">
          {stops.map((s, i) => (
            <div className="stop-row" key={i}>
              <div className="field" style={{ margin: 0 }}>
                <label htmlFor={`k${i}`}>Type</label>
                <select id={`k${i}`} className="input" value={s.kind} onChange={(e) => setStop(i, { kind: e.target.value as Stop["kind"] })}>
                  <option value="pickup">Pickup</option>
                  <option value="delivery">Delivery</option>
                </select>
              </div>
              <div className="field" style={{ margin: 0 }}>
                <label htmlFor={`a${i}`}>Address</label>
                <input id={`a${i}`} className="input" value={s.address} onChange={(e) => setStop(i, { address: e.target.value })} required />
              </div>
              <div className="field" style={{ margin: 0 }}>
                <label htmlFor={`t${i}`}>Required arrival</label>
                <input id={`t${i}`} className="input" type="datetime-local" value={s.requiredAt} onChange={(e) => setStop(i, { requiredAt: e.target.value })} />
              </div>
              <div className="actions">
                <button type="button" className="btn btn-ghost btn-sm" onClick={() => move(i, -1)} disabled={i === 0} aria-label={`Move stop ${i + 1} up`}>
                  Up
                </button>
                <button type="button" className="btn btn-ghost btn-sm" onClick={() => move(i, 1)} disabled={i === stops.length - 1} aria-label={`Move stop ${i + 1} down`}>
                  Down
                </button>
                <button type="button" className="btn btn-danger btn-sm" onClick={() => setStops((x) => x.filter((_, j) => j !== i))} disabled={stops.length <= 2}>
                  Remove
                </button>
              </div>
            </div>
          ))}
          <div>
            <button type="button" className="btn btn-ghost btn-sm" onClick={() => setStops((s) => [...s.slice(0, -1), blankStop("delivery"), s[s.length - 1]])}>
              Add stop
            </button>
          </div>
        </div>
      </section>

      <section className="panel">
        <h2>Money (PHP)</h2>
        <div className="grid-form two">
          <div className="field">
            <label htmlFor="rate">Customer contract rate</label>
            <input id="rate" className="input" inputMode="decimal" value={f.contractRate} onChange={set("contractRate")} required />
            <span className="muted">Never shown to drivers.</span>
          </div>
          <div className="field">
            <label htmlFor="payout">Driver pay (your own driver)</label>
            <input id="payout" className="input" inputMode="decimal" value={f.payout} onChange={set("payout")} required />
            <span className="muted">What you pay a driver of your own truck.</span>
          </div>
          <div className="field">
            <label htmlFor="subpayout">Subcontractor rate</label>
            <input id="subpayout" className="input" inputMode="decimal" value={f.subPayout} onChange={set("subPayout")} />
            <span className="muted">What you pay a subcontractor for the truck and driver. Leave empty to pay the same as the driver pay.</span>
          </div>
          <div className="field">
            <label htmlFor="helperpay">Helper pay (your own truck)</label>
            <input id="helperpay" className="input" inputMode="decimal" value={f.helperPay} onChange={set("helperPay")} />
            <span className="muted">What you pay the helper (pahinante). A subcontractor pays their own helper.</span>
          </div>
          <label className="check">
            <input type="checkbox" checked={f.fuelIncluded} onChange={set("fuelIncluded")} /> Fuel included in payout
          </label>
          <label className="check">
            <input type="checkbox" checked={f.tollIncluded} onChange={set("tollIncluded")} /> Tolls included in payout
          </label>
          <div className="field span2">
            <label htmlFor="est">Diesel, RFID or tolls you will pay yourself (optional, for the check only)</label>
            <input id="est" className="input" inputMode="decimal" value={estCosts} onChange={(e) => setEstCosts(e.target.value)} />
          </div>
        </div>
        <div style={{ marginTop: 12 }}>
          <div className="stack">
            <QuoteBox customerPays={f.contractRate} offer={f.payout} yourCosts={addPesos(estCosts, f.helperPay)} who="your driver (and helper)" />
            {f.subPayout.trim() !== "" && <QuoteBox customerPays={f.contractRate} offer={f.subPayout} yourCosts={estCosts} who="the subcontractor" id="quote-box-sub" />}
          </div>
        </div>
      </section>

      <button className="btn btn-primary btn-lg" disabled={busy}>
        {busy ? "Saving…" : "Create trip"}
      </button>
    </form>
  );
}
