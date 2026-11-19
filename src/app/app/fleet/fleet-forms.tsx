"use client";

import { useRouter } from "next/navigation";
import { useState, type FormEvent } from "react";
import { post } from "@/components/api";
import { TRUCK_TYPES } from "@/shared/truck-types";

/** Red when expired or missing, amber within 30 days. Pure: the caller supplies today and the 30-day horizon. */
export function ExpiryBadge({ date, today, soon }: { date: string | null; today: string; soon: string }) {
  if (!date) return <span className="chip chip-bad">Not recorded</span>;
  const cls = date < today ? "chip chip-bad" : date <= soon ? "chip chip-warn" : "chip";
  return (
    <span className={cls}>
      {date}
      {date < today ? " (expired)" : ""}
    </span>
  );
}

async function send(method: string, url: string, body: unknown) {
  try {
    const res = await fetch(url, { method, headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    const json = await res.json().catch(() => null);
    if (!res.ok) {
      const issues = Array.isArray(json?.issues) ? json.issues.map((i: { message: string }) => i.message).join(". ") : "";
      return { ok: false, error: issues || json?.error || "Something went wrong" };
    }
    return { ok: true, error: null };
  } catch {
    return { ok: false, error: "Cannot reach the server." };
  }
}

export function FleetForms({ drivers }: { drivers: { userId: string; name: string }[] }) {
  const router = useRouter();
  const [t, setT] = useState({ plate: "", truckType: TRUCK_TYPES[2] as string, capacityKg: "", registrationExpiry: "", inspectionExpiry: "" });
  const [d, setD] = useState({ userId: drivers[0]?.userId ?? "", licenseNumber: "", licenseExpiry: "", phone: "" });
  const [tErr, setTErr] = useState<string | null>(null);
  const [dErr, setDErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function addTruck(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setTErr(null);
    const res = await post("/api/trucks", {
      plate: t.plate,
      truckType: t.truckType,
      capacityKg: Number(t.capacityKg),
      registrationExpiry: t.registrationExpiry || undefined,
      inspectionExpiry: t.inspectionExpiry || undefined,
    });
    setBusy(false);
    if (!res.ok) return setTErr(res.error);
    setT({ plate: "", truckType: TRUCK_TYPES[2], capacityKg: "", registrationExpiry: "", inspectionExpiry: "" });
    router.refresh();
  }

  async function saveDriver(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setDErr(null);
    const res = await send("PUT", `/api/fleet/drivers/${d.userId}`, { licenseNumber: d.licenseNumber, licenseExpiry: d.licenseExpiry, phone: d.phone || undefined });
    setBusy(false);
    if (!res.ok) return setDErr(res.error);
    setD((x) => ({ ...x, licenseNumber: "", licenseExpiry: "", phone: "" }));
    router.refresh();
  }

  return (
    <>
      <form onSubmit={addTruck} className="panel stack" noValidate>
        <h2>Add a truck</h2>
        {tErr && <div className="alert" role="alert">{tErr}</div>}
        <div className="grid-form two">
          <div className="field">
            <label htmlFor="t-plate">Plate number</label>
            <input id="t-plate" className="input" value={t.plate} onChange={(e) => setT({ ...t, plate: e.target.value })} required />
          </div>
          <div className="field">
            <label htmlFor="t-type">Truck type</label>
            <select id="t-type" className="input" value={t.truckType} onChange={(e) => setT({ ...t, truckType: e.target.value })}>
              {TRUCK_TYPES.map((x) => <option key={x}>{x}</option>)}
            </select>
          </div>
          <div className="field">
            <label htmlFor="t-cap">Capacity (kg)</label>
            <input id="t-cap" className="input" inputMode="numeric" value={t.capacityKg} onChange={(e) => setT({ ...t, capacityKg: e.target.value })} required />
          </div>
          <div className="field">
            <label htmlFor="t-reg">Registration expires</label>
            <input id="t-reg" className="input" type="date" value={t.registrationExpiry} onChange={(e) => setT({ ...t, registrationExpiry: e.target.value })} />
          </div>
          <div className="field">
            <label htmlFor="t-insp">Inspection expires</label>
            <input id="t-insp" className="input" type="date" value={t.inspectionExpiry} onChange={(e) => setT({ ...t, inspectionExpiry: e.target.value })} />
          </div>
        </div>
        <div><button className="btn btn-primary" disabled={busy || !t.plate || !t.capacityKg}>Add truck</button></div>
      </form>

      {drivers.length > 0 && (
        <form onSubmit={saveDriver} className="panel stack" noValidate>
          <h2>Driver license details</h2>
          {dErr && <div className="alert" role="alert">{dErr}</div>}
          <div className="grid-form two">
            <div className="field">
              <label htmlFor="d-user">Driver</label>
              <select id="d-user" className="input" value={d.userId} onChange={(e) => setD({ ...d, userId: e.target.value })}>
                {drivers.map((x) => <option key={x.userId} value={x.userId}>{x.name}</option>)}
              </select>
            </div>
            <div className="field">
              <label htmlFor="d-no">License number</label>
              <input id="d-no" className="input" value={d.licenseNumber} onChange={(e) => setD({ ...d, licenseNumber: e.target.value })} required />
            </div>
            <div className="field">
              <label htmlFor="d-exp">License expires</label>
              <input id="d-exp" className="input" type="date" value={d.licenseExpiry} onChange={(e) => setD({ ...d, licenseExpiry: e.target.value })} required />
            </div>
            <div className="field">
              <label htmlFor="d-phone">Phone (optional)</label>
              <input id="d-phone" className="input" inputMode="tel" value={d.phone} onChange={(e) => setD({ ...d, phone: e.target.value })} />
            </div>
          </div>
          <div><button className="btn btn-primary" disabled={busy || !d.licenseNumber || !d.licenseExpiry}>Save license</button></div>
        </form>
      )}
    </>
  );
}
