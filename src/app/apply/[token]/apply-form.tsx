"use client";

import { useState, type FormEvent } from "react";
import { post } from "@/components/api";
import { APPLICATION_PHOTOS, MAX_EXTRA_TRUCKS, OTHER, TRUCK_SIZES, photoField } from "@/shared/application";
import { TRUCK_TYPES } from "@/shared/truck-types";

const TRUCK_TEXT_FIELDS = ["plateNumber", "capacityKg", "truckType", "truckTypeOther", "truckSize", "truckSizeOther", "driverName", "licenseNumber", "licenseExpiry"] as const;

function Field({ id, name, label, ...props }: { id: string; name: string; label: string } & React.InputHTMLAttributes<HTMLInputElement>) {
  return (
    <div className="field" style={{ margin: 0 }}>
      <label htmlFor={id}>{label}</label>
      <input id={id} name={name} className="input" {...props} />
    </div>
  );
}

/** One truck, its driver and its six photos. Index 0 is the first truck; further trucks use a t1_, t2_... prefix. */
function TruckSection({ index, position, onRemove }: { index: number; position: number; onRemove?: () => void }) {
  const pre = index === 0 ? "" : `t${index}_`;
  const [type, setType] = useState<string>(TRUCK_TYPES[1]);
  const [size, setSize] = useState<string>("14ft");
  const id = (n: string) => `${pre}${n}`;
  return (
    <>
      <section className="panel stack" aria-label={`Truck ${position}`}>
        <div className="page-head">
          <h2>{index === 0 ? "The truck" : `Truck ${position}`}</h2>
          {onRemove && (
            <button type="button" className="btn btn-ghost btn-sm" onClick={onRemove}>
              Remove this truck
            </button>
          )}
        </div>
        <div className="grid-form two">
          <Field id={id("plateNumber")} name={id("plateNumber")} label="Plate number" required placeholder="NBC 1234" />
          <Field id={id("capacityKg")} name={id("capacityKg")} label="Capacity in kg (optional)" inputMode="numeric" />
          <div className="field" style={{ margin: 0 }}>
            <label htmlFor={id("truckType")}>Type of truck</label>
            <select id={id("truckType")} name={id("truckType")} className="input" value={type} onChange={(e) => setType(e.target.value)}>
              {[...TRUCK_TYPES, OTHER].map((t) => <option key={t} value={t}>{t}</option>)}
            </select>
          </div>
          {type === OTHER && <Field id={id("truckTypeOther")} name={id("truckTypeOther")} label="What type of truck?" required />}
          <div className="field" style={{ margin: 0 }}>
            <label htmlFor={id("truckSize")}>Size</label>
            <select id={id("truckSize")} name={id("truckSize")} className="input" value={size} onChange={(e) => setSize(e.target.value)}>
              {TRUCK_SIZES.map((t) => <option key={t} value={t}>{t}</option>)}
            </select>
          </div>
          {size === OTHER && <Field id={id("truckSizeOther")} name={id("truckSizeOther")} label="What size?" required />}
        </div>
      </section>

      <section className="panel stack" aria-label={`Driver of truck ${position}`}>
        <h2>{index === 0 ? "The driver" : `Driver of truck ${position}`}</h2>
        <div className="grid-form two">
          <Field id={id("driverName")} name={id("driverName")} label="Driver name" required />
          <Field id={id("licenseNumber")} name={id("licenseNumber")} label="License number (optional)" />
          <Field id={id("licenseExpiry")} name={id("licenseExpiry")} label="License expiry (optional)" type="date" />
        </div>
      </section>

      <section className="panel stack" aria-label={`Photos of truck ${position}`}>
        <h2>{index === 0 ? "Photos" : `Photos of truck ${position}`}</h2>
        <p className="muted">JPG, PNG or WebP, up to 10 MB each. On a phone you can take the photo directly.</p>
        <div className="grid-form two">
          {APPLICATION_PHOTOS.map((p) => {
            const field = photoField(index, p.kind);
            return (
              <div className="field" style={{ margin: 0 }} key={p.kind}>
                <label htmlFor={field}>{p.label}</label>
                <input id={field} name={field} type="file" accept="image/jpeg,image/png,image/webp" className="input" required />
              </div>
            );
          })}
        </div>
      </section>
    </>
  );
}

export function ApplyForm({ token }: { token: string }) {
  // Each extra truck gets a stable key so removing one does not shuffle what was typed into the others.
  const [extras, setExtras] = useState<number[]>([]);
  const [nextKey, setNextKey] = useState(1);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);
  const [busy, setBusy] = useState(false);

  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setError(null);
    const raw = new FormData(e.currentTarget);
    const data = new FormData();
    // Everything that is not an extra truck's own field goes straight through.
    const extraKeys = new Set<string>();
    for (const k of extras) for (const f of [...TRUCK_TEXT_FIELDS, ...APPLICATION_PHOTOS.map((p) => p.kind)]) extraKeys.add(`t${k}_${f}`);
    for (const [k, v] of raw.entries()) if (!extraKeys.has(k)) data.append(k, v);

    // Renumber the extra trucks 1..n in the order shown, whatever their keys are.
    const extraTrucks: Record<string, string>[] = [];
    extras.forEach((k, i) => {
      const n = i + 1;
      const t: Record<string, string> = {};
      for (const f of TRUCK_TEXT_FIELDS) {
        const v = raw.get(`t${k}_${f}`);
        if (typeof v === "string" && v.trim() !== "") t[f] = v;
      }
      extraTrucks.push(t);
      for (const p of APPLICATION_PHOTOS) {
        const file = raw.get(photoField(k, p.kind));
        if (file instanceof File && file.size > 0) data.append(photoField(n, p.kind), file);
      }
    });
    if (extraTrucks.length) data.set("extraTrucks", JSON.stringify(extraTrucks));

    for (let i = 0; i <= extras.length; i++) {
      for (const p of APPLICATION_PHOTOS) {
        const f = data.get(photoField(i, p.kind));
        if (!(f instanceof File) || f.size === 0) return setError(`${extras.length ? `Truck ${i + 1}: ` : ""}please add a photo: ${p.label}.`);
      }
    }
    setBusy(true);
    const res = await post(`/api/apply/${token}`, data);
    setBusy(false);
    if (!res.ok) return setError(res.error);
    setDone(true);
  }

  if (done) {
    return (
      <div className="panel stack" role="status">
        <h1>Application received</h1>
        <p>Thank you. The company will review your {extras.length ? "trucks" : "truck"} and contact you on the phone number and email you gave.</p>
      </div>
    );
  }

  return (
    <form onSubmit={submit} className="stack" noValidate aria-label="Subcontractor application">
      <div>
        <h1>Apply as a subcontractor</h1>
        <p className="sub" style={{ margin: 0 }}>Fill in your details and upload clear photos of each truck and its driver&apos;s license. Have more than one unit? Add each truck below.</p>
      </div>
      {error && <div className="alert" role="alert">{error}</div>}

      <section className="panel stack">
        <h2>About you</h2>
        <div className="grid-form two">
          <Field id="companyName" name="companyName" label="Company or owner name" required autoComplete="organization" />
          <Field id="contactName" name="contactName" label="Contact person" required autoComplete="name" />
          <Field id="phone" name="phone" label="Mobile number" required inputMode="tel" placeholder="0917 123 4567" autoComplete="tel" />
          <Field id="email" name="email" label="Email" required type="email" autoComplete="email" />
        </div>
        <Field id="address" name="address" label="Address (optional)" />
      </section>

      <TruckSection index={0} position={1} />
      {extras.map((k, i) => (
        <TruckSection key={k} index={k} position={i + 2} onRemove={() => setExtras(extras.filter((x) => x !== k))} />
      ))}

      {extras.length < MAX_EXTRA_TRUCKS && (
        <div>
          <button
            type="button"
            className="btn btn-ghost"
            onClick={() => {
              setExtras([...extras, nextKey]);
              setNextKey(nextKey + 1);
            }}
          >
            + Add another truck
          </button>
        </div>
      )}

      <div className="field" style={{ margin: 0 }}>
        <label htmlFor="notes">Anything else we should know? (optional)</label>
        <textarea id="notes" name="notes" className="input" rows={3} maxLength={1000} />
      </div>

      {/* Honeypot: hidden from people, bots fill it in. */}
      <div aria-hidden="true" style={{ position: "absolute", left: "-9999px" }}>
        <label htmlFor="website">Leave this empty</label>
        <input id="website" name="website" tabIndex={-1} autoComplete="off" />
      </div>

      <div><button className="btn btn-primary" disabled={busy}>{busy ? "Sending…" : extras.length ? `Send application (${extras.length + 1} trucks)` : "Send application"}</button></div>
    </form>
  );
}
