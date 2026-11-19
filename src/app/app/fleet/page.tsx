import type { Metadata } from "next";
import { requireTenant } from "@/server/auth/current";
import { can } from "@/server/policy";
import { listDrivers, listTrucks } from "@/server/services/fleet";
import { FleetForms, ExpiryBadge } from "./fleet-forms";

export const metadata: Metadata = { title: "Fleet" };

export default async function FleetPage() {
  const actor = await requireTenant();
  if (!can(actor, "fleet:read")) return <div className="empty">Your role does not include the fleet.</div>;
  const [trucks, drivers] = await Promise.all([listTrucks(actor), listDrivers(actor)]);
  const manage = can(actor, "fleet:manage");
  const now = new Date();
  const today = now.toISOString().slice(0, 10);
  const soon = new Date(now.getTime() + 30 * 86_400_000).toISOString().slice(0, 10);
  return (
    <div className="stack">
      <div className="page-head">
        <h1>Fleet</h1>
      </div>

      <section className="stack" aria-labelledby="trucks">
        <h2 id="trucks" style={{ fontSize: 16 }}>Trucks ({trucks.length})</h2>
        {trucks.length === 0 ? (
          <div className="empty">No trucks yet. Drivers cannot accept trips without one.</div>
        ) : (
          <table className="table">
            <thead>
              <tr><th>Plate</th><th>Type</th><th>Capacity</th><th>Registration</th><th>Inspection</th><th>Status</th></tr>
            </thead>
            <tbody>
              {trucks.map((t) => (
                <tr key={t.id}>
                  <td className="mono">{t.plate}</td>
                  <td>{t.truckType}</td>
                  <td>{t.capacityKg.toLocaleString()} kg</td>
                  <td><ExpiryBadge date={t.registrationExpiry} today={today} soon={soon} /></td>
                  <td><ExpiryBadge date={t.inspectionExpiry} today={today} soon={soon} /></td>
                  <td>{t.status}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      <section className="stack" aria-labelledby="drivers">
        <h2 id="drivers" style={{ fontSize: 16 }}>Drivers ({drivers.length})</h2>
        {drivers.length === 0 ? (
          <div className="empty">No drivers yet. Add them on the Team page.</div>
        ) : (
          <table className="table">
            <thead>
              <tr><th>Name</th><th>License no.</th><th>License expires</th></tr>
            </thead>
            <tbody>
              {drivers.map((d) => (
                <tr key={d.userId}>
                  <td>{d.name}</td>
                  <td className="mono">{d.licenseNumber ?? "-"}</td>
                  <td><ExpiryBadge date={d.licenseExpiry} today={today} soon={soon} /></td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      {manage && <FleetForms drivers={drivers.map((d) => ({ userId: d.userId, name: d.name }))} />}
    </div>
  );
}
