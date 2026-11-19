"use client";

import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { post } from "@/components/api";

const stepLabel: Record<string, string> = {
  started: "Start trip",
  arrived_pickup: "Arrived at pickup",
  loaded: "Cargo loaded",
  in_transit: "In transit",
  arrived_destination: "Arrived at destination",
};

interface TruckOption {
  id: string;
  plate: string;
  truckType: string;
  capacityKg: number;
  reasons: string[];
}

/** Choose one of your trucks (each shows why it would be refused) and accept, or decline a direct offer. */
export function AcceptPanel({ tripId, direct }: { tripId: string; direct: boolean }) {
  const router = useRouter();
  const [trucks, setTrucks] = useState<TruckOption[] | null>(null);
  const [truckId, setTruckId] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sent, setSent] = useState(false);

  useEffect(() => {
    let alive = true;
    fetch(`/api/trips/${tripId}/options`)
      .then((r) => r.json())
      .then((d) => {
        if (!alive) return;
        setTrucks(d.trucks ?? []);
        setTruckId((d.trucks ?? []).find((t: TruckOption) => t.reasons.length === 0)?.id ?? "");
      })
      .catch(() => alive && setTrucks([]));
    return () => {
      alive = false;
    };
  }, [tripId]);

  async function act(path: "claim" | "decline") {
    setBusy(true);
    setError(null);
    const res = await post<{ status?: string }>(`/api/trips/${tripId}/${path}`, path === "claim" ? { truckId } : undefined);
    setBusy(false);
    if (!res.ok) return setError(res.error);
    if (path === "decline") return router.replace("/app");
    if (res.data?.status === "pending") setSent(true);
    router.refresh();
  }

  if (sent) return <div className="notice ok-note" role="status">Request sent. Dispatch will confirm it.</div>;
  const chosen = trucks?.find((t) => t.id === truckId);
  return (
    <section className="panel stack">
      <h2>Accept this trip</h2>
      {error && <div className="alert" role="alert">{error}</div>}
      {trucks === null && <p className="muted">Checking your trucks…</p>}
      {trucks?.length === 0 && <div className="alert">You have no trucks on file. Ask the office to add one.</div>}
      {trucks && trucks.length > 0 && (
        <div className="field" style={{ margin: 0 }}>
          <label htmlFor="truck">Truck you will use</label>
          <select id="truck" className="input" value={truckId} onChange={(e) => setTruckId(e.target.value)}>
            <option value="">Choose a truck</option>
            {trucks.map((t) => (
              <option key={t.id} value={t.id} disabled={t.reasons.length > 0}>
                {t.plate} · {t.truckType} · {t.capacityKg} kg{t.reasons.length ? " (not suitable)" : ""}
              </option>
            ))}
          </select>
          {trucks.filter((t) => t.reasons.length).map((t) => (
            <span className="muted" key={t.id}>{t.plate}: {t.reasons.join(" ")}</span>
          ))}
        </div>
      )}
      <button className="btn btn-primary btn-lg" disabled={busy || !chosen} onClick={() => act("claim")}>
        {busy ? "Sending…" : "Accept this trip"}
      </button>
      {direct && (
        <button className="btn btn-ghost" disabled={busy} onClick={() => act("decline")}>
          Decline
        </button>
      )}
    </section>
  );
}

export function WithdrawRequest({ tripId }: { tripId: string }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  return (
    <section className="panel stack">
      <div className="notice">You asked to take this trip. Waiting for dispatch to confirm.</div>
      <button
        className="btn btn-ghost"
        disabled={busy}
        onClick={async () => {
          setBusy(true);
          await post(`/api/trips/${tripId}/withdraw`);
          setBusy(false);
          router.refresh();
        }}
      >
        Withdraw my request
      </button>
    </section>
  );
}

export function AdvanceButton({ tripId, next }: { tripId: string; next: string }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  return (
    <section className="panel stack">
      {error && <div className="alert" role="alert">{error}</div>}
      <button
        className="btn btn-primary btn-lg"
        disabled={busy}
        onClick={async () => {
          setBusy(true);
          setError(null);
          const res = await post(`/api/trips/${tripId}/advance`, { to: next });
          setBusy(false);
          if (!res.ok) return setError(res.error);
          router.refresh();
        }}
      >
        {busy ? "Saving…" : stepLabel[next] ?? next}
      </button>
    </section>
  );
}
