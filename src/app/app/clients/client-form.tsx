"use client";

import { useRouter } from "next/navigation";
import { useState, type FormEvent } from "react";
import { post } from "@/components/api";

export function ClientForm() {
  const router = useRouter();
  const [f, setF] = useState({ name: "", contactName: "", contactPhone: "", address: "" });
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const set = (k: keyof typeof f) => (e: { target: { value: string } }) => setF((p) => ({ ...p, [k]: e.target.value }));

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    const res = await post("/api/customers", f);
    setBusy(false);
    if (!res.ok) return setError(res.error);
    setF({ name: "", contactName: "", contactPhone: "", address: "" });
    router.refresh();
  }

  return (
    <form onSubmit={submit} className="panel stack" noValidate>
      <h2>Add a client</h2>
      {error && <div className="alert" role="alert">{error}</div>}
      <div className="grid-form two">
        <div className="field">
          <label htmlFor="c-name">Client name</label>
          <input id="c-name" className="input" value={f.name} onChange={set("name")} required />
        </div>
        <div className="field">
          <label htmlFor="c-contact">Contact person</label>
          <input id="c-contact" className="input" value={f.contactName} onChange={set("contactName")} />
        </div>
        <div className="field">
          <label htmlFor="c-phone">Phone</label>
          <input id="c-phone" className="input" inputMode="tel" value={f.contactPhone} onChange={set("contactPhone")} />
        </div>
        <div className="field">
          <label htmlFor="c-addr">Address</label>
          <input id="c-addr" className="input" value={f.address} onChange={set("address")} />
        </div>
      </div>
      <div>
        <button className="btn btn-primary" disabled={busy || !f.name.trim()}>{busy ? "Saving…" : "Add client"}</button>
      </div>
    </form>
  );
}
