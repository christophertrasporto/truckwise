import { deleteDraft, getDraft, listDrafts, putDraft, type Draft } from "./db";

/**
 * Upload engine for proof drafts. Rules:
 *  - A submission is written to the phone FIRST, then uploaded, so nothing is lost if the signal drops.
 *  - The idempotency key makes retries safe: the server returns the existing version instead of a new one.
 *  - Network trouble and server errors keep the draft queued; they are retried when the phone is online again.
 *  - Problems the user must see (the trip was reassigned, proof was already reviewed, ...) become "conflict".
 *    They are never retried and never overwrite anything: the person decides to discard.
 */

export type Outcome = "synced" | "queued" | "failed" | "conflict";

function buildForm(d: Draft): FormData {
  const fd = new FormData();
  for (const [k, v] of Object.entries(d.fields)) if (v !== "") fd.set(k, v);
  fd.set("stopId", d.stopId);
  fd.set("idempotencyKey", d.key);
  if (d.wasOffline && d.queuedAt) {
    fd.set("submittedOffline", "true");
    fd.set("deviceQueuedAt", d.queuedAt);
  }
  d.photos.forEach((f) => fd.append("photos", f));
  if (d.signature) fd.set("signature", new File([d.signature], "signature.png", { type: "image/png" }));
  d.pdfs.forEach((f) => fd.append("pdfs", f));
  return fd;
}

/** Uploads one draft and records the result on the phone. */
export async function syncOne(key: string): Promise<Outcome> {
  const d = await getDraft(key);
  if (!d || d.state === "synced") return "synced";
  await putDraft({ ...d, state: "uploading", attempts: d.attempts + 1 });
  let res: Response;
  try {
    res = await fetch(`/api/trips/${d.tripId}/pod`, { method: "POST", body: buildForm(d), credentials: "same-origin" });
  } catch {
    await putDraft({ ...d, state: "queued", wasOffline: true, attempts: d.attempts + 1, error: "No connection. It will upload when you are back online." });
    return "queued";
  }
  if (res.ok) {
    await deleteDraft(key);
    return "synced";
  }
  const body = await res.json().catch(() => ({}) as { error?: string; code?: string });
  const message: string = body.error ?? `Upload failed (${res.status})`;
  if (res.status === 404 || res.status === 409) {
    await putDraft({ ...d, state: "conflict", attempts: d.attempts + 1, error: message, code: body.code ?? null });
    return "conflict";
  }
  if (res.status === 400 || res.status === 413 || res.status === 422) {
    await putDraft({ ...d, state: "failed", attempts: d.attempts + 1, error: message, code: body.code ?? null });
    return "failed";
  }
  // 401 (signed out) and 5xx: keep it, try again later.
  await putDraft({ ...d, state: "queued", wasOffline: true, attempts: d.attempts + 1, error: res.status === 401 ? "Sign in again to upload." : message });
  return "queued";
}

/** Save the submission on the phone, then try to upload it straight away. */
export async function submitOrQueue(d: Draft): Promise<{ outcome: Outcome; message: string | null }> {
  await putDraft({ ...d, state: "queued", queuedAt: new Date().toISOString(), error: null, code: null });
  const outcome = await syncOne(d.key);
  const after = await getDraft(d.key);
  return { outcome, message: after?.error ?? null };
}

let running = false;

/** Uploads every queued draft, one at a time. Safe to call often; only one run goes at a time. */
export async function syncAll(): Promise<void> {
  if (running || (typeof navigator !== "undefined" && navigator.onLine === false)) return;
  running = true;
  try {
    const locks = (navigator as Navigator & { locks?: LockManager }).locks;
    const work = async () => {
      for (const d of await listDrafts()) {
        // "uploading" left behind by a closed tab is picked up again; the idempotency key keeps it safe.
        if (d.state === "queued" || d.state === "uploading") await syncOne(d.key);
      }
    };
    if (locks) await locks.request("lalolu-proof-sync", { ifAvailable: true }, async (lock) => (lock ? work() : undefined));
    else await work();
  } finally {
    running = false;
  }
}

/** Ask the browser to run the service worker's own sync later (Chrome-based browsers; elsewhere the page does the work). */
export async function requestBackgroundSync(): Promise<void> {
  try {
    const reg = await navigator.serviceWorker?.ready;
    const sync = (reg as ServiceWorkerRegistration & { sync?: { register(tag: string): Promise<void> } } | undefined)?.sync;
    if (sync) await sync.register("lalolu-proof-sync");
  } catch {
    /* not supported: the page-level engine still runs on the "online" event and on a timer */
  }
}
