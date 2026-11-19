"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { post } from "@/components/api";

interface Result {
  status: "approved" | "rejected";
  loginEmail?: string;
  temporaryPassword?: string | null;
}

export function ReviewForm({ id }: { id: string }) {
  const router = useRouter();
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<Result | null>(null);

  async function decide(decision: "approve" | "reject") {
    setError(null);
    if (decision === "reject" && !note.trim()) return setError("Say why you are rejecting it.");
    setBusy(true);
    const res = await post<Result>(`/api/applications/${id}/review`, { decision, note: note || undefined });
    setBusy(false);
    if (!res.ok) return setError(res.error);
    if (decision === "approve") setResult(res.data);
    else router.refresh();
  }

  if (result?.status === "approved") {
    return (
      <div className="panel stack" role="status">
        <h2>Approved</h2>
        <p>The subcontractor company and its truck were created.</p>
        {result.temporaryPassword ? (
          <>
            <p>Give these sign-in details to the applicant. The password is shown only once.</p>
            <dl className="kv">
              <div><dt>Email</dt><dd>{result.loginEmail}</dd></div>
              <div><dt>Temporary password</dt><dd><code>{result.temporaryPassword}</code></dd></div>
            </dl>
          </>
        ) : (
          <p>They already have a login with {result.loginEmail}, so their existing password still works.</p>
        )}
        <div><button className="btn btn-ghost" onClick={() => router.refresh()}>Done</button></div>
      </div>
    );
  }

  return (
    <div className="panel stack">
      <h2>Decision</h2>
      {error && <div className="alert" role="alert">{error}</div>}
      <div className="field" style={{ margin: 0 }}>
        <label htmlFor="r-note">Note (required to reject)</label>
        <input id="r-note" className="input" value={note} onChange={(e) => setNote(e.target.value)} />
      </div>
      <div className="actions">
        <button className="btn btn-primary" disabled={busy} onClick={() => decide("approve")}>Approve</button>
        <button className="btn btn-danger" disabled={busy} onClick={() => decide("reject")}>Reject</button>
      </div>
    </div>
  );
}
