"use client";

import { useRouter } from "next/navigation";
import { useState, type FormEvent } from "react";
import { post } from "@/components/api";

export interface DocType {
  id: string;
  name: string;
  instructions: string | null;
  required: boolean;
  uploader: "driver" | "dispatcher" | "either";
  active: boolean;
}

const WHO = { either: "Driver or dispatch", driver: "Driver", dispatcher: "Dispatch" } as const;

/** The documents one client wants for every trip. Changes apply to trips created from now on. */
export function DocumentTypes({ customerId, customerName, types, canEdit }: { customerId: string; customerName: string; types: DocType[]; canEdit: boolean }) {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [name, setName] = useState("");
  const [instructions, setInstructions] = useState("");
  const [required, setRequired] = useState(true);
  const [uploader, setUploader] = useState<DocType["uploader"]>("either");

  async function patch(id: string, body: Record<string, unknown>) {
    setError(null);
    setBusy(true);
    const res = await fetch(`/api/document-types/${id}`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    setBusy(false);
    if (!res.ok) return setError((await res.json().catch(() => null))?.error ?? "Could not save");
    router.refresh();
  }

  async function add(e: FormEvent) {
    e.preventDefault();
    setError(null);
    if (name.trim().length < 2) return setError("Give the document a name, for example Signed delivery receipt.");
    setBusy(true);
    const res = await post(`/api/customers/${customerId}/documents`, { name, instructions: instructions || undefined, required, uploader });
    setBusy(false);
    if (!res.ok) return setError(res.error);
    setName("");
    setInstructions("");
    router.refresh();
  }

  const active = types.filter((t) => t.active);
  return (
    <div className="stack" style={{ marginTop: 8 }}>
      {error && <div className="alert" role="alert">{error}</div>}
      {types.length === 0 && <p className="muted">No documents set up. Trips for {customerName} will not ask for any.</p>}
      {types.map((t) => (
        <div key={t.id} style={{ display: "flex", justifyContent: "space-between", gap: 8, flexWrap: "wrap", opacity: t.active ? 1 : 0.55 }}>
          <div>
            <b>{t.name}</b> <span className="muted">{t.required ? "Required" : "Optional"} · {WHO[t.uploader]} uploads{t.active ? "" : " · switched off"}</span>
            {t.instructions && <div className="muted">{t.instructions}</div>}
          </div>
          {canEdit && (
            <div className="actions">
              <button className="btn btn-ghost btn-sm" disabled={busy} onClick={() => patch(t.id, { required: !t.required })}>{t.required ? "Make optional" : "Make required"}</button>
              <button className="btn btn-ghost btn-sm" disabled={busy} onClick={() => patch(t.id, { active: !t.active })}>{t.active ? "Switch off" : "Switch on"}</button>
            </div>
          )}
        </div>
      ))}
      {canEdit && (
        <form onSubmit={add} className="stack" aria-label={`Add a document for ${customerName}`} noValidate>
          <div className="grid-form two">
            <div className="field" style={{ margin: 0 }}>
              <label htmlFor={`dt-name-${customerId}`}>Document name</label>
              <input id={`dt-name-${customerId}`} className="input" value={name} onChange={(e) => setName(e.target.value)} placeholder="Signed delivery receipt" />
            </div>
            <div className="field" style={{ margin: 0 }}>
              <label htmlFor={`dt-who-${customerId}`}>Who uploads it</label>
              <select id={`dt-who-${customerId}`} className="input" value={uploader} onChange={(e) => setUploader(e.target.value as DocType["uploader"])}>
                <option value="either">Driver or dispatch</option>
                <option value="driver">Driver</option>
                <option value="dispatcher">Dispatch</option>
              </select>
            </div>
          </div>
          <div className="field" style={{ margin: 0 }}>
            <label htmlFor={`dt-note-${customerId}`}>Instructions (optional)</label>
            <input id={`dt-note-${customerId}`} className="input" value={instructions} onChange={(e) => setInstructions(e.target.value)} placeholder="Must show the consignee's stamp and signature" />
          </div>
          <label style={{ display: "flex", gap: 8, alignItems: "center" }}><input type="checkbox" checked={required} onChange={(e) => setRequired(e.target.checked)} /> Required before the trip can be billed</label>
          <div><button className="btn btn-primary btn-sm" disabled={busy}>Add document</button> <span className="muted">{active.length} active</span></div>
        </form>
      )}
    </div>
  );
}
