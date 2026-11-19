"use client";

import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { post } from "@/components/api";

interface Options {
  drivers: { userId: string; name: string; reasons: string[] }[];
  trucks: { id: string; plate: string; truckType: string; capacityKg: number; reasons: string[] }[];
}

/** Pick one of the company's trucks and drivers; ones that would be refused are shown with the reason. */
export function PartnerAccept({ haulerId, tripId }: { haulerId: string; tripId: string }) {
  const router = useRouter();
  const base = `/api/partner/trips/${haulerId}/${tripId}`;
  const [opts, setOpts] = useState<Options | null>(null);
  const [truckId, setTruckId] = useState("");
  const [driverUserId, setDriverUserId] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    fetch(`${base}/options`)
      .then((r) => r.json())
      .then((d: Options) => {
        if (!alive) return;
        setOpts({ drivers: d.drivers ?? [], trucks: d.trucks ?? [] });
        setTruckId(d.trucks?.find((t) => t.reasons.length === 0)?.id ?? "");
        setDriverUserId(d.drivers?.find((x) => x.reasons.length === 0)?.userId ?? "");
      })
      .catch(() => alive && setOpts({ drivers: [], trucks: [] }));
    return () => {
      alive = false;
    };
  }, [base]);

  async function accept() {
    setBusy(true);
    setError(null);
    const res = await post(`${base}/accept`, { truckId, driverUserId });
    setBusy(false);
    if (!res.ok) return setError(res.error);
    router.refresh();
  }
  async function decline() {
    setBusy(true);
    // Only a direct offer can be declined; for an open offer there is nothing to withdraw, so just go back.
    await post(`${base}/decline`);
    setBusy(false);
    router.replace("/app");
  }

  return (
    <section className="panel stack">
      <h2>Accept for our company</h2>
      {error && <div className="alert" role="alert">{error}</div>}
      {opts === null && <p className="muted">Checking your trucks and drivers…</p>}
      {opts && (opts.trucks.length === 0 || opts.drivers.length === 0) && (
        <div className="alert">Add at least one truck and one driver (with license details) under Fleet and Team first.</div>
      )}
      {opts && opts.trucks.length > 0 && opts.drivers.length > 0 && (
        <div className="grid-form two">
          <div className="field">
            <label htmlFor="p-truck">Truck</label>
            <select id="p-truck" className="input" value={truckId} onChange={(e) => setTruckId(e.target.value)}>
              <option value="">Choose a truck</option>
              {opts.trucks.map((t) => (
                <option key={t.id} value={t.id} disabled={t.reasons.length > 0}>
                  {t.plate} · {t.truckType} · {t.capacityKg} kg{t.reasons.length ? " (not suitable)" : ""}
                </option>
              ))}
            </select>
            {opts.trucks.filter((t) => t.reasons.length).map((t) => (
              <span className="muted" key={t.id}>{t.plate}: {t.reasons.join(" ")}</span>
            ))}
          </div>
          <div className="field">
            <label htmlFor="p-driver">Driver</label>
            <select id="p-driver" className="input" value={driverUserId} onChange={(e) => setDriverUserId(e.target.value)}>
              <option value="">Choose a driver</option>
              {opts.drivers.map((d) => (
                <option key={d.userId} value={d.userId} disabled={d.reasons.length > 0}>
                  {d.name}{d.reasons.length ? " (not available)" : ""}
                </option>
              ))}
            </select>
            {opts.drivers.filter((d) => d.reasons.length).map((d) => (
              <span className="muted" key={d.userId}>{d.name}: {d.reasons.join(" ")}</span>
            ))}
          </div>
        </div>
      )}
      <div className="actions">
        <button className="btn btn-primary" disabled={busy || !truckId || !driverUserId} onClick={accept}>
          {busy ? "Sending…" : "Accept trip"}
        </button>
        <button className="btn btn-ghost" disabled={busy} onClick={decline}>Decline</button>
      </div>
      <p className="muted">If this company requires approval, your acceptance is sent as a request first.</p>
    </section>
  );
}
