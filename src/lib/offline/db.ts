/**
 * Offline proof drafts, stored in the phone's IndexedDB. The same database layout is read by the
 * service worker (public/sw.js), so keep DB_NAME, STORE and the record shape in step with it.
 */
export const DB_NAME = "lalolu-offline";
export const STORE = "drafts";

export type DraftState = "draft" | "queued" | "uploading" | "synced" | "failed" | "conflict";

export interface Draft {
  /** The idempotency key sent to the server. A retry can never create a second version. */
  key: string;
  tripId: string;
  stopId: string;
  tripRef: string;
  stopLabel: string;
  /** Plain text form fields (outcome, receiver, quantity, notes, delivery time, GPS, ...). */
  fields: Record<string, string>;
  photos: File[];
  signature: Blob | null;
  pdfs: File[];
  state: DraftState;
  /** Phone clock when it was queued. Reported to the server as device-reported, never as the delivery time. */
  queuedAt: string | null;
  /** True once an upload attempt failed for lack of a connection, so the server can record the offline path. */
  wasOffline: boolean;
  attempts: number;
  error: string | null;
  code: string | null;
  updatedAt: string;
}

function open(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) {
        const s = db.createObjectStore(STORE, { keyPath: "key" });
        s.createIndex("state", "state");
        s.createIndex("trip_stop", ["tripId", "stopId"]);
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function run<T>(mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  const db = await open();
  try {
    return await new Promise<T>((resolve, reject) => {
      const tx = db.transaction(STORE, mode);
      const req = fn(tx.objectStore(STORE));
      tx.oncomplete = () => resolve(req.result);
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error);
    });
  } finally {
    db.close();
  }
}

export const putDraft = (d: Draft) => run("readwrite", (s) => s.put({ ...d, updatedAt: new Date().toISOString() })).then(notify);
export const getDraft = (key: string) => run<Draft | undefined>("readonly", (s) => s.get(key));
export const deleteDraft = (key: string) => run("readwrite", (s) => s.delete(key)).then(notify);
export const listDrafts = () => run<Draft[]>("readonly", (s) => s.getAll());

/** The unfinished record for a stop, if the phone has one. */
export async function draftForStop(tripId: string, stopId: string): Promise<Draft | undefined> {
  return (await listDrafts()).find((d) => d.tripId === tripId && d.stopId === stopId && d.state !== "synced");
}

export const CHANGE_EVENT = "lalolu-offline-change";
function notify() {
  if (typeof window !== "undefined") window.dispatchEvent(new CustomEvent(CHANGE_EVENT));
}
