"use client";

import { useState, type FormEvent } from "react";
import { post } from "@/components/api";

export function PasswordForm() {
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);
  const [busy, setBusy] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    setDone(false);
    const res = await post("/api/auth/password", { currentPassword: current, newPassword: next });
    setBusy(false);
    if (!res.ok) return setError(res.error);
    setDone(true);
    setCurrent("");
    setNext("");
  }

  return (
    <form onSubmit={submit} className="panel stack" noValidate>
      <h2>Change password</h2>
      {error && <div className="alert" role="alert">{error}</div>}
      {done && <div className="notice ok-note" role="status">Password changed. Your other sessions were signed out.</div>}
      <div className="field">
        <label htmlFor="cur">Current password</label>
        <input id="cur" className="input" type="password" autoComplete="current-password" value={current} onChange={(e) => setCurrent(e.target.value)} required />
      </div>
      <div className="field">
        <label htmlFor="new">New password (10+ characters)</label>
        <input id="new" className="input" type="password" autoComplete="new-password" value={next} onChange={(e) => setNext(e.target.value)} required />
      </div>
      <div>
        <button className="btn btn-primary" disabled={busy || !current || next.length < 10}>{busy ? "Saving…" : "Change password"}</button>
      </div>
    </form>
  );
}
