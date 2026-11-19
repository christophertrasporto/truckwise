"use client";

import { useRouter } from "next/navigation";
import { useEffect, useRef, useState, type FormEvent } from "react";
import { SignaturePad } from "@/components/signature-pad";
import { deleteDraft, draftForStop, putDraft, type Draft } from "@/lib/offline/db";
import { requestBackgroundSync, submitOrQueue } from "@/lib/offline/queue";

const toLocalInput = (d: Date) => new Date(d.getTime() - d.getTimezoneOffset() * 60_000).toISOString().slice(0, 16);

interface Props {
  tripId: string;
  tripRef: string;
  stopId: string;
  stopLabel: string;
  expectedQuantity: number | null;
  allowPdf: boolean;
}

/**
 * Proof of delivery for one delivery stop. Everything is written to the phone first, so a dropped signal
 * never loses the work: it is saved, marked as waiting, and uploaded automatically when the phone is back online.
 * GPS is optional and only read when the driver taps the button and the browser allows it.
 */
export function PodForm({ tripId, tripRef, stopId, stopLabel, expectedQuantity, allowPdf }: Props) {
  const router = useRouter();
  const idempotencyKey = useRef("");
  const [existing, setExisting] = useState<Draft | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [outcome, setOutcome] = useState("complete");
  const [receiver, setReceiver] = useState("");
  const [qty, setQty] = useState(expectedQuantity != null ? String(expectedQuantity) : "");
  const [notes, setNotes] = useState("");
  const [comments, setComments] = useState("");
  const [when, setWhen] = useState(() => toLocalInput(new Date()));
  const [photos, setPhotos] = useState<File[]>([]);
  const [pdfs, setPdfs] = useState<File[]>([]);
  const [signature, setSignature] = useState<Blob | null>(null);
  const [gps, setGps] = useState<{ consent: "granted" | "denied" | "unavailable"; lat?: number; lng?: number; acc?: number }>({ consent: "unavailable" });
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // Restore anything the phone already holds for this stop (a saved draft, a waiting upload, a conflict).
  useEffect(() => {
    let alive = true;
    draftForStop(tripId, stopId)
      .then((d) => {
        if (!alive) return;
        idempotencyKey.current = d?.key ?? crypto.randomUUID();
        if (d) {
          setExisting(d);
          if (d.state === "draft") {
            const f = d.fields;
            setOutcome(f.outcome ?? "complete");
            setReceiver(f.receiverName ?? "");
            setQty(f.deliveredQuantity ?? "");
            setNotes(f.discrepancyNotes ?? "");
            setComments(f.comments ?? "");
            if (f.actualDeliveryAt) setWhen(toLocalInput(new Date(f.actualDeliveryAt)));
            setPhotos(d.photos);
            setPdfs(d.pdfs);
            setSignature(d.signature);
          }
        }
      })
      .catch(() => (idempotencyKey.current = crypto.randomUUID()))
      .finally(() => alive && setLoaded(true));
    return () => {
      alive = false;
    };
  }, [tripId, stopId]);

  function captureLocation() {
    if (!("geolocation" in navigator)) return setGps({ consent: "unavailable" });
    navigator.geolocation.getCurrentPosition(
      (p) => setGps({ consent: "granted", lat: p.coords.latitude, lng: p.coords.longitude, acc: p.coords.accuracy }),
      (e) => setGps({ consent: e.code === e.PERMISSION_DENIED ? "denied" : "unavailable" }),
      { enableHighAccuracy: true, timeout: 10_000 },
    );
  }

  function toDraft(state: Draft["state"]): Draft {
    const fields: Record<string, string> = {
      outcome,
      receiverName: receiver,
      actualDeliveryAt: new Date(when).toISOString(),
      gpsConsent: gps.consent,
    };
    if (qty) fields.deliveredQuantity = qty;
    if (notes) fields.discrepancyNotes = notes;
    if (comments) fields.comments = comments;
    if (gps.consent === "granted") {
      fields.gpsLat = String(gps.lat);
      fields.gpsLng = String(gps.lng);
      fields.gpsAccuracyM = String(gps.acc);
    }
    return {
      key: idempotencyKey.current,
      tripId,
      stopId,
      tripRef,
      stopLabel,
      fields,
      photos,
      signature,
      pdfs,
      state,
      queuedAt: null,
      wasOffline: false,
      attempts: 0,
      error: null,
      code: null,
      updatedAt: new Date().toISOString(),
    };
  }

  async function saveDraft() {
    setError(null);
    try {
      await putDraft(toDraft("draft"));
      setNotice("Draft saved on this phone. You can finish it later, even without a signal.");
    } catch {
      setError("This browser cannot save drafts. Submit when you have a signal.");
    }
  }

  async function submit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setNotice(null);
    if (photos.length === 0) return setError("Take or choose at least one photo of the delivery or signed receipt.");
    if (!receiver.trim()) return setError("Enter the receiver name.");
    if (outcome !== "complete" && !notes.trim()) return setError("Describe what was short, damaged, missing, or why delivery failed.");
    setBusy(true);
    try {
      const r = await submitOrQueue(toDraft("queued"));
      if (r.outcome === "synced") {
        router.refresh();
      } else if (r.outcome === "queued") {
        setNotice("Saved on this phone. It will upload automatically when you have a signal.");
        void requestBackgroundSync();
        setExisting(await draftForStop(tripId, stopId).then((d) => d ?? null));
      } else {
        setError(r.message ?? "Could not submit.");
        setExisting(await draftForStop(tripId, stopId).then((d) => d ?? null));
      }
    } catch {
      // IndexedDB unavailable: fall back to a direct upload attempt so the driver is never blocked.
      setError("This browser cannot store the proof offline. Check your connection and try again.");
    } finally {
      setBusy(false);
    }
  }

  if (!loaded) return <section className="panel"><p className="muted">Loading…</p></section>;

  if (existing && existing.state !== "draft") {
    const waiting = existing.state === "queued" || existing.state === "uploading";
    return (
      <section className="panel stack" aria-label={`Proof for ${stopLabel}`}>
        <h2>Proof for {stopLabel}</h2>
        {waiting ? (
          <div className="notice" data-testid="pod-waiting">Saved on this phone, waiting to upload. {existing.error ?? ""}</div>
        ) : (
          <div className="alert" role="alert" data-testid="pod-problem">
            {existing.state === "conflict" ? "This proof could not be saved. " : "The server refused this proof. "}
            {existing.error}
          </div>
        )}
        {!waiting && (
          <button
            className="btn btn-ghost"
            onClick={async () => {
              await deleteDraft(existing.key);
              idempotencyKey.current = crypto.randomUUID();
              setExisting(null);
              router.refresh();
            }}
          >
            Discard and start again
          </button>
        )}
      </section>
    );
  }

  return (
    <form onSubmit={submit} className="panel stack" noValidate aria-label={`Proof for ${stopLabel}`}>
      <h2>Proof of delivery: {stopLabel}</h2>
      {error && <div className="alert" role="alert">{error}</div>}
      {notice && <div className="notice ok-note" role="status">{notice}</div>}
      <div className="field">
        <label htmlFor={`outcome-${stopId}`}>How did the delivery go?</label>
        <select id={`outcome-${stopId}`} className="input" value={outcome} onChange={(e) => setOutcome(e.target.value)}>
          <option value="complete">Complete delivery</option>
          <option value="partial">Partial delivery</option>
          <option value="discrepancy">Delivered with discrepancy (damaged or short)</option>
          <option value="failed">Delivery failed</option>
        </select>
      </div>
      <div className="field">
        <label htmlFor={`receiver-${stopId}`}>Receiver name</label>
        <input id={`receiver-${stopId}`} className="input" value={receiver} onChange={(e) => setReceiver(e.target.value)} required />
      </div>
      <div className="field">
        <label htmlFor={`qty-${stopId}`}>Quantity delivered</label>
        <input id={`qty-${stopId}`} className="input" inputMode="numeric" value={qty} onChange={(e) => setQty(e.target.value)} />
      </div>
      {outcome !== "complete" && (
        <div className="field">
          <label htmlFor={`notes-${stopId}`}>What was short, damaged, missing, or why it failed</label>
          <textarea id={`notes-${stopId}`} className="input" value={notes} onChange={(e) => setNotes(e.target.value)} required />
        </div>
      )}
      <div className="field">
        <label htmlFor={`when-${stopId}`}>Delivery time (as you confirm it)</label>
        <input id={`when-${stopId}`} className="input" type="datetime-local" value={when} onChange={(e) => setWhen(e.target.value)} required />
        <span className="muted">If you are uploading late, enter when it was actually delivered. The upload time is recorded separately.</span>
      </div>

      <div className="field dropzone">
        <label htmlFor={`photos-${stopId}`}>Photos (cargo, receiver, signed receipt)</label>
        <input
          id={`photos-${stopId}`}
          className="input"
          style={{ paddingTop: 12 }}
          type="file"
          accept="image/*"
          capture="environment"
          multiple
          onChange={(e) => {
            const added = Array.from(e.target.files ?? []);
            setPhotos((p) => [...p, ...added].slice(0, 8));
            e.target.value = ""; // lets the camera be used again for the next photo
          }}
        />
        {photos.length > 0 && (
          <ul className="file-list" style={{ margin: 0, paddingLeft: 18 }}>
            {photos.map((f, i) => (
              <li key={`${f.name}-${i}`}>
                {f.name}{" "}
                <button type="button" className="btn btn-ghost btn-sm" onClick={() => setPhotos((p) => p.filter((_, j) => j !== i))} aria-label={`Remove photo ${f.name}`}>
                  Remove
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>

      <SignaturePad onChange={setSignature} initial={signature} />

      {allowPdf && (
        <div className="field">
          <label htmlFor={`pdf-${stopId}`}>PDF receipt (optional)</label>
          <input id={`pdf-${stopId}`} className="input" style={{ paddingTop: 12 }} type="file" accept="application/pdf" multiple onChange={(e) => setPdfs(Array.from(e.target.files ?? []).slice(0, 3))} />
        </div>
      )}

      <div className="field">
        <label htmlFor={`comments-${stopId}`}>Comments (optional)</label>
        <textarea id={`comments-${stopId}`} className="input" value={comments} onChange={(e) => setComments(e.target.value)} />
      </div>
      <div className="field">
        <span style={{ fontWeight: 600, fontSize: 14 }}>Location (optional)</span>
        <div className="actions">
          <button type="button" className="btn btn-ghost btn-sm" onClick={captureLocation}>Add my location</button>
          <span className="muted" role="status">
            {gps.consent === "granted" ? "Location will be attached" : gps.consent === "denied" ? "Location not shared" : "Not attached. You can submit without it."}
          </span>
        </div>
      </div>
      <button className="btn btn-primary btn-lg" disabled={busy}>{busy ? "Sending…" : "Submit proof"}</button>
      <button type="button" className="btn btn-ghost" onClick={saveDraft} disabled={busy}>Save draft</button>
    </form>
  );
}
