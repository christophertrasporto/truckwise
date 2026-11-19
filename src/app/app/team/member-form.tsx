"use client";

import { useRouter } from "next/navigation";
import { useState, type FormEvent } from "react";
import { post } from "@/components/api";

export function MemberForm({ partner }: { partner: boolean }) {
  const router = useRouter();
  const [f, setF] = useState({ name: "", email: "", role: partner ? "sub_driver" : "driver", password: "" });
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const set = (k: keyof typeof f) => (e: { target: { value: string } }) => setF((p) => ({ ...p, [k]: e.target.value }));

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    setDone(null);
    const res = await post("/api/members", f);
    setBusy(false);
    if (!res.ok) return setError(res.error);
    setDone(`${f.name} was added. Share the password with them privately and ask them to change it under Account.`);
    setF({ name: "", email: "", role: partner ? "sub_driver" : "driver", password: "" });
    router.refresh();
  }

  return (
    <form onSubmit={submit} className="panel stack" noValidate>
      <h2>Add a team member</h2>
      {error && <div className="alert" role="alert">{error}</div>}
      {done && <div className="notice ok-note" role="status">{done}</div>}
      <div className="grid-form two">
        <div className="field">
          <label htmlFor="m-name">Full name</label>
          <input id="m-name" className="input" value={f.name} onChange={set("name")} required />
        </div>
        <div className="field">
          <label htmlFor="m-email">Email (used to sign in)</label>
          <input id="m-email" className="input" type="email" value={f.email} onChange={set("email")} required />
        </div>
        <div className="field">
          <label htmlFor="m-role">Role</label>
          <select id="m-role" className="input" value={f.role} onChange={set("role")}>
            {partner ? (
              <>
                <option value="sub_driver">Driver</option>
                <option value="sub_manager">Manager</option>
              </>
            ) : (
              <>
                <option value="driver">Driver</option>
                <option value="dispatcher">Dispatcher</option>
                <option value="accountant">Accountant</option>
                <option value="ops_manager">Operations manager</option>
              </>
            )}
          </select>
        </div>
        <div className="field">
          <label htmlFor="m-pw">Starting password (10+ characters)</label>
          <input id="m-pw" className="input" type="text" autoComplete="off" value={f.password} onChange={set("password")} required />
        </div>
      </div>
      <div>
        <button className="btn btn-primary" disabled={busy}>{busy ? "Adding…" : "Add member"}</button>
      </div>
    </form>
  );
}
