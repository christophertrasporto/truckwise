"use client";

import { useRouter } from "next/navigation";
import { useState, type FormEvent } from "react";
import { post } from "@/components/api";

export function PartnerStatusButton({ tenantId, next }: { tenantId: string; next: "approved" | "revoked" }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  return (
    <button
      className={next === "revoked" ? "btn btn-danger btn-sm" : "btn btn-ghost btn-sm"}
      disabled={busy}
      onClick={async () => {
        setBusy(true);
        await post(`/api/partners/${tenantId}`, { status: next });
        setBusy(false);
        router.refresh();
      }}
    >
      {next === "revoked" ? "Revoke" : "Approve again"}
    </button>
  );
}

export function PartnerForms() {
  const router = useRouter();
  const [f, setF] = useState({ companyName: "", ownerName: "", ownerEmail: "", password: "" });
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const set = (k: keyof typeof f) => (e: { target: { value: string } }) => setF((p) => ({ ...p, [k]: e.target.value }));

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    setDone(null);
    const res = await post("/api/partners", f);
    setBusy(false);
    if (!res.ok) return setError(res.error);
    setDone(`${f.companyName} was added and approved. Share the starting password with ${f.ownerName} privately.`);
    setF({ companyName: "", ownerName: "", ownerEmail: "", password: "" });
    router.refresh();
  }

  return (
    <form onSubmit={submit} className="panel stack" noValidate>
      <h2>Add a subcontractor company</h2>
      {error && <div className="alert" role="alert">{error}</div>}
      {done && <div className="notice ok-note" role="status">{done}</div>}
      <div className="grid-form two">
        <div className="field">
          <label htmlFor="s-co">Company name</label>
          <input id="s-co" className="input" value={f.companyName} onChange={set("companyName")} required />
        </div>
        <div className="field">
          <label htmlFor="s-owner">Owner name</label>
          <input id="s-owner" className="input" value={f.ownerName} onChange={set("ownerName")} required />
        </div>
        <div className="field">
          <label htmlFor="s-email">Owner email (their login)</label>
          <input id="s-email" className="input" type="email" value={f.ownerEmail} onChange={set("ownerEmail")} required />
        </div>
        <div className="field">
          <label htmlFor="s-pw">Starting password (10+ characters)</label>
          <input id="s-pw" className="input" autoComplete="off" value={f.password} onChange={set("password")} required />
        </div>
      </div>
      <div><button className="btn btn-primary" disabled={busy}>{busy ? "Adding…" : "Add and approve"}</button></div>
    </form>
  );
}
