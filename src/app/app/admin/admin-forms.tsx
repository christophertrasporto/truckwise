"use client";

import { useRouter } from "next/navigation";
import { useRef, useState, type FormEvent } from "react";
import { post } from "@/components/api";
import { pesosToCentavos } from "@/shared/format";
import { PLAN_FEATURES } from "@/shared/plans";

type Plan = { id: string; name: string };

export function CreateCompanyForm({ plans }: { plans: Plan[] }) {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [created, setCreated] = useState<{ ownerEmail: string; temporaryPassword: string | null } | null>(null);

  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setError(null);
    const f = new FormData(e.currentTarget);
    setBusy(true);
    const res = await post<{ ownerEmail: string; temporaryPassword: string | null }>("/api/admin/companies", {
      companyName: f.get("companyName"),
      ownerName: f.get("ownerName"),
      ownerEmail: f.get("ownerEmail"),
      planId: f.get("planId"),
      trialDays: Number(f.get("trialDays") || 0),
    });
    setBusy(false);
    if (!res.ok) return setError(res.error);
    setCreated(res.data);
    (e.target as HTMLFormElement).reset();
    router.refresh();
  }

  return (
    <form onSubmit={submit} className="panel stack" aria-label="Create a trucking company">
      <h2>Add a trucking company</h2>
      {error && <div className="alert" role="alert">{error}</div>}
      {created && (
        <div className="notice ok-note" role="status">
          Company created. Owner login: {created.ownerEmail}.{" "}
          {created.temporaryPassword ? <>Temporary password (shown once): <code>{created.temporaryPassword}</code></> : "They already have an account, so their existing password works."}
        </div>
      )}
      <div className="grid-form two">
        <div className="field" style={{ margin: 0 }}><label htmlFor="companyName">Company name</label><input id="companyName" name="companyName" className="input" required /></div>
        <div className="field" style={{ margin: 0 }}><label htmlFor="ownerName">Owner name</label><input id="ownerName" name="ownerName" className="input" required /></div>
        <div className="field" style={{ margin: 0 }}><label htmlFor="ownerEmail">Owner email</label><input id="ownerEmail" name="ownerEmail" type="email" className="input" required /></div>
        <div className="field" style={{ margin: 0 }}>
          <label htmlFor="planId">Plan</label>
          <select id="planId" name="planId" className="input" required>{plans.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}</select>
        </div>
        <div className="field" style={{ margin: 0 }}><label htmlFor="trialDays">Free trial (days)</label><input id="trialDays" name="trialDays" className="input" inputMode="numeric" defaultValue="14" /></div>
      </div>
      <div><button className="btn btn-primary" disabled={busy || plans.length === 0}>{busy ? "Creating…" : "Create company"}</button>{plans.length === 0 && <span className="muted"> Create a plan first.</span>}</div>
    </form>
  );
}

export interface PlanRow {
  id?: string;
  name: string;
  description: string | null;
  priceCentavos: number;
  periodMonths: number;
  maxTrucks: number | null;
  maxDrivers: number | null;
  maxUsers: number | null;
  features: Record<string, boolean>;
  active: boolean;
}

const limitText = (n: number | null) => (n === null ? "" : String(n));

/** Create a plan, or edit one when `plan` has an id. */
export function PlanForm({ plan }: { plan?: PlanRow }) {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [busy, setBusy] = useState(false);

  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setError(null);
    setSaved(false);
    const f = new FormData(e.currentTarget);
    const price = pesosToCentavos(String(f.get("price") ?? ""));
    if (price === null) return setError("Enter the price, for example 1500 or 1,500.00.");
    const limit = (k: string) => {
      const v = String(f.get(k) ?? "").trim();
      return v === "" ? null : Number(v);
    };
    const body = {
      name: f.get("name"),
      description: String(f.get("description") ?? "") || undefined,
      priceCentavos: price,
      periodMonths: Number(f.get("periodMonths")),
      maxTrucks: limit("maxTrucks"),
      maxDrivers: limit("maxDrivers"),
      maxUsers: limit("maxUsers"),
      features: Object.fromEntries(PLAN_FEATURES.map((x) => [x.key, f.get(`f_${x.key}`) === "on"])),
      active: f.get("active") === "on",
    };
    setBusy(true);
    const res = plan?.id
      ? await fetch(`/api/admin/plans/${plan.id}`, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }).then(async (r) => ({ ok: r.ok, error: r.ok ? null : ((await r.json().catch(() => null))?.error ?? "Could not save") as string | null }))
      : await post("/api/admin/plans", body);
    setBusy(false);
    if (!res.ok) return setError(res.error);
    setSaved(true);
    router.refresh();
  }

  const k = plan?.id ?? "new";
  return (
    <form onSubmit={submit} className="panel stack" aria-label={plan?.id ? `Edit plan ${plan.name}` : "Create a plan"}>
      <h2>{plan?.id ? plan.name : "New plan"}</h2>
      {error && <div className="alert" role="alert">{error}</div>}
      {saved && <div className="notice ok-note" role="status">Saved.</div>}
      <div className="grid-form two">
        <div className="field" style={{ margin: 0 }}><label htmlFor={`name-${k}`}>Name</label><input id={`name-${k}`} name="name" className="input" defaultValue={plan?.name} required /></div>
        <div className="field" style={{ margin: 0 }}><label htmlFor={`price-${k}`}>Price per period (PHP)</label><input id={`price-${k}`} name="price" className="input" inputMode="decimal" defaultValue={plan ? (plan.priceCentavos / 100).toFixed(2) : ""} required /></div>
        <div className="field" style={{ margin: 0 }}>
          <label htmlFor={`months-${k}`}>Period</label>
          <select id={`months-${k}`} name="periodMonths" className="input" defaultValue={plan?.periodMonths ?? 1}>
            <option value={1}>Monthly</option><option value={3}>Every 3 months</option><option value={12}>Yearly</option>
          </select>
        </div>
        <div className="field" style={{ margin: 0 }}><label htmlFor={`desc-${k}`}>Description (optional)</label><input id={`desc-${k}`} name="description" className="input" defaultValue={plan?.description ?? ""} /></div>
        <div className="field" style={{ margin: 0 }}><label htmlFor={`trucks-${k}`}>Max trucks (blank = unlimited)</label><input id={`trucks-${k}`} name="maxTrucks" className="input" inputMode="numeric" defaultValue={limitText(plan?.maxTrucks ?? null)} /></div>
        <div className="field" style={{ margin: 0 }}><label htmlFor={`drivers-${k}`}>Max drivers (blank = unlimited)</label><input id={`drivers-${k}`} name="maxDrivers" className="input" inputMode="numeric" defaultValue={limitText(plan?.maxDrivers ?? null)} /></div>
        <div className="field" style={{ margin: 0 }}><label htmlFor={`users-${k}`}>Max people (blank = unlimited)</label><input id={`users-${k}`} name="maxUsers" className="input" inputMode="numeric" defaultValue={limitText(plan?.maxUsers ?? null)} /></div>
      </div>
      <fieldset style={{ border: 0, padding: 0, margin: 0 }}>
        <legend className="muted">Included features</legend>
        {PLAN_FEATURES.map((x) => (
          <label key={x.key} style={{ display: "flex", gap: 8, alignItems: "center", padding: "4px 0" }}>
            <input type="checkbox" name={`f_${x.key}`} defaultChecked={plan ? !!plan.features[x.key] : true} /> {x.label}
          </label>
        ))}
      </fieldset>
      <label style={{ display: "flex", gap: 8, alignItems: "center" }}><input type="checkbox" name="active" defaultChecked={plan?.active ?? true} /> Available for new companies</label>
      <div><button className="btn btn-primary" disabled={busy}>{busy ? "Saving…" : plan?.id ? "Save plan" : "Create plan"}</button></div>
    </form>
  );
}

export function CompanyActions({ id, status, planId, plans, hasSubscription }: { id: string; status: string; planId: string | null; plans: Plan[]; hasSubscription: boolean }) {
  const router = useRouter();
  const key = useRef(crypto.randomUUID());
  const [today] = useState(() => new Date(Date.now() + 8 * 3600_000).toISOString().slice(0, 10));
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function run(fn: () => Promise<{ ok: boolean; error: string | null }>, ok: string) {
    setError(null);
    setNote(null);
    setBusy(true);
    const res = await fn();
    setBusy(false);
    if (!res.ok) return setError(res.error);
    setNote(ok);
    router.refresh();
  }

  return (
    <div className="stack">
      {error && <div className="alert" role="alert">{error}</div>}
      {note && <div className="notice ok-note" role="status">{note}</div>}

      <section className="panel stack" aria-label="Company status">
        <h2>{status === "active" ? "Suspend this company" : "Reactivate this company"}</h2>
        <p className="muted">{status === "active" ? "People in this company will see only a renewal notice until you reactivate it." : "People will be able to use the system again."}</p>
        <button
          className={status === "active" ? "btn btn-danger" : "btn btn-primary"}
          disabled={busy}
          onClick={() => {
            const reason = prompt(status === "active" ? "Why is this company being suspended?" : "Why is it being reactivated?");
            if (!reason || reason.trim().length < 3) return;
            void run(() => post(`/api/admin/companies/${id}/status`, { status: status === "active" ? "suspended" : "active", reason }), status === "active" ? "Company suspended." : "Company reactivated.");
          }}
        >
          {status === "active" ? "Suspend" : "Reactivate"}
        </button>
      </section>

      {hasSubscription && (
        <>
          <form
            className="panel stack"
            aria-label="Change plan"
            onSubmit={(e) => {
              e.preventDefault();
              const f = new FormData(e.currentTarget);
              void run(() => post(`/api/admin/companies/${id}/plan`, { planId: f.get("planId") }), "Plan changed.");
            }}
          >
            <h2>Change plan</h2>
            <div className="field" style={{ margin: 0 }}>
              <label htmlFor="chg-plan">Plan</label>
              <select id="chg-plan" name="planId" className="input" defaultValue={planId ?? undefined}>{plans.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}</select>
            </div>
            <div><button className="btn btn-ghost" disabled={busy}>Change plan</button></div>
          </form>

          <form
            className="panel stack"
            aria-label="Record a payment"
            onSubmit={(e) => {
              e.preventDefault();
              const f = new FormData(e.currentTarget);
              const amount = pesosToCentavos(String(f.get("amount") ?? ""));
              if (!amount) return setError("Enter the amount received, for example 1500.");
              void run(
                () => post(`/api/admin/companies/${id}/payments`, { amountCentavos: amount, paidOn: f.get("paidOn"), method: String(f.get("method") ?? "") || undefined, reference: String(f.get("reference") ?? "") || undefined, periodsAdded: Number(f.get("periods") || 1), idempotencyKey: key.current }),
                "Payment recorded and the subscription extended.",
              ).then(() => (key.current = crypto.randomUUID()));
            }}
          >
            <h2>Record a payment</h2>
            <p className="muted">Recording a payment extends the subscription. If it had expired, the company comes back.</p>
            <div className="grid-form two">
              <div className="field" style={{ margin: 0 }}><label htmlFor="pay-amt">Amount received (PHP)</label><input id="pay-amt" name="amount" className="input" inputMode="decimal" required /></div>
              <div className="field" style={{ margin: 0 }}><label htmlFor="pay-date">Date received</label><input id="pay-date" name="paidOn" type="date" className="input" defaultValue={today} required /></div>
              <div className="field" style={{ margin: 0 }}><label htmlFor="pay-per">Periods paid for</label><input id="pay-per" name="periods" className="input" inputMode="numeric" defaultValue="1" /></div>
              <div className="field" style={{ margin: 0 }}><label htmlFor="pay-method">Method (optional)</label><input id="pay-method" name="method" className="input" placeholder="GCash, bank transfer, cash" /></div>
              <div className="field" style={{ margin: 0 }}><label htmlFor="pay-ref">Reference (optional)</label><input id="pay-ref" name="reference" className="input" /></div>
            </div>
            <div><button className="btn btn-primary" disabled={busy}>Record payment</button></div>
          </form>
        </>
      )}
    </div>
  );
}
