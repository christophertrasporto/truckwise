"use client";

import { useRouter } from "next/navigation";
import { useState, type FormEvent } from "react";
import { post } from "@/components/api";

function useAction() {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  async function run(fn: () => Promise<{ ok: boolean; error: string | null }>) {
    setError(null);
    setBusy(true);
    const res = await fn();
    setBusy(false);
    if (!res.ok) return setError(res.error);
    router.refresh();
  }
  return { busy, error, run };
}

export function UploadDocument({ tripId, docId, label }: { tripId: string; docId: string; label: string }) {
  const { busy, error, run } = useAction();
  return (
    <div>
      <label className="btn btn-primary btn-sm" style={{ cursor: busy ? "wait" : "pointer" }}>
        {busy ? "Uploading…" : "Upload"}
        <input
          type="file"
          accept="image/jpeg,image/png,image/webp,application/pdf"
          aria-label={`Upload ${label}`}
          disabled={busy}
          style={{ position: "absolute", width: 1, height: 1, opacity: 0, overflow: "hidden" }}
          onChange={(e) => {
            const file = e.target.files?.[0];
            e.target.value = "";
            if (!file) return;
            const fd = new FormData();
            fd.set("file", file);
            void run(() => post(`/api/trips/${tripId}/documents/${docId}/upload`, fd));
          }}
        />
      </label>
      {error && <div className="alert" role="alert" style={{ marginTop: 6 }}>{error}</div>}
    </div>
  );
}

export function ReviewDocument({ fileId }: { fileId: string }) {
  const { busy, error, run } = useAction();
  return (
    <div className="actions">
      <button className="btn btn-primary btn-sm" disabled={busy} onClick={() => run(() => post(`/api/trip-document-files/${fileId}/review`, { decision: "approve" }))}>Approve</button>
      <button
        className="btn btn-danger btn-sm"
        disabled={busy}
        onClick={() => {
          const note = prompt("What is wrong with this document? The driver will see it.");
          if (!note || !note.trim()) return;
          void run(() => post(`/api/trip-document-files/${fileId}/review`, { decision: "reject", note }));
        }}
      >
        Reject
      </button>
      {error && <span className="alert" role="alert">{error}</span>}
    </div>
  );
}

export function WaiveDocument({ docId }: { docId: string }) {
  const { busy, error, run } = useAction();
  return (
    <>
      <button
        className="btn btn-ghost btn-sm"
        disabled={busy}
        onClick={() => {
          const reason = prompt("Why is this document not needed for this trip? (kept on record)");
          if (!reason || reason.trim().length < 3) return;
          void run(() => post(`/api/trip-documents/${docId}/waive`, { reason }));
        }}
      >
        Not needed
      </button>
      {error && <span className="alert" role="alert">{error}</span>}
    </>
  );
}

export function RemoveDocument({ docId }: { docId: string }) {
  const { busy, run } = useAction();
  return (
    <button className="btn btn-ghost btn-sm" disabled={busy} onClick={() => run(() => post(`/api/trip-documents/${docId}/remove`))}>
      Remove
    </button>
  );
}

export function AddTripDocument({ tripId }: { tripId: string }) {
  const { busy, error, run } = useAction();
  const [name, setName] = useState("");
  const [required, setRequired] = useState(true);
  async function submit(e: FormEvent) {
    e.preventDefault();
    if (name.trim().length < 2) return;
    await run(() => post(`/api/trips/${tripId}/documents`, { name, required, uploader: "either" }));
    setName("");
  }
  return (
    <form onSubmit={submit} className="stack" aria-label="Add a document for this trip" noValidate>
      <div className="actions" style={{ alignItems: "end" }}>
        <div className="field" style={{ margin: 0, flex: 1, minWidth: 180 }}>
          <label htmlFor="doc-name">Add a document for this trip only</label>
          <input id="doc-name" className="input" value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Gate pass" />
        </div>
        <label style={{ display: "flex", gap: 6, alignItems: "center" }}><input type="checkbox" checked={required} onChange={(e) => setRequired(e.target.checked)} /> Required</label>
        <button className="btn btn-ghost" disabled={busy}>Add</button>
      </div>
      {error && <div className="alert" role="alert">{error}</div>}
    </form>
  );
}
