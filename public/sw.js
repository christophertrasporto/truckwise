/* Truckwise service worker. Best-effort offline support for installed/mobile use.
 *  - Static build assets: cache-first.
 *  - App pages the driver has already opened: network-first, falling back to the last copy so the proof form can be
 *    filled in without a signal. Cleared on sign-out. API calls and signed file URLs are NEVER cached.
 *  - Queued proof uploads: retried on the browser "sync" event where supported (Chrome-based browsers).
 * Keep the IndexedDB layout in step with src/lib/offline/db.ts.
 */
const STATIC = "lalolu-static-v1";
const PAGES = "lalolu-pages-v1";
const DB_NAME = "lalolu-offline";
const STORE = "drafts";

self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (e) => e.waitUntil(self.clients.claim()));

self.addEventListener("message", (e) => {
  if (e.data && e.data.type === "clear-pages") e.waitUntil(caches.delete(PAGES));
});

self.addEventListener("fetch", (e) => {
  const req = e.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin || url.pathname.startsWith("/api/")) return;

  if (url.pathname.startsWith("/_next/static/")) {
    e.respondWith(
      caches.open(STATIC).then(async (cache) => {
        const hit = await cache.match(req);
        if (hit) return hit;
        const res = await fetch(req);
        if (res.ok) cache.put(req, res.clone());
        return res;
      }),
    );
    return;
  }

  if (req.mode === "navigate" && url.pathname.startsWith("/app")) {
    e.respondWith(
      fetch(req)
        .then((res) => {
          if (res.ok && res.type === "basic") {
            const copy = res.clone();
            caches.open(PAGES).then((c) => c.put(req, copy));
          }
          return res;
        })
        .catch(async () => (await caches.match(req)) || Response.error()),
    );
  }
});

function openDb() {
  return new Promise((resolve, reject) => {
    const r = indexedDB.open(DB_NAME, 1);
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
    r.onupgradeneeded = () => {
      if (!r.result.objectStoreNames.contains(STORE)) r.result.createObjectStore(STORE, { keyPath: "key" });
    };
  });
}
const tx = (db, mode, fn) =>
  new Promise((resolve, reject) => {
    const t = db.transaction(STORE, mode);
    const req = fn(t.objectStore(STORE));
    t.oncomplete = () => resolve(req.result);
    t.onerror = () => reject(t.error);
  });

function formFor(d) {
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

async function syncDrafts() {
  const db = await openDb();
  const drafts = await tx(db, "readonly", (s) => s.getAll());
  let retry = false;
  for (const d of drafts) {
    if (d.state !== "queued" && d.state !== "uploading") continue;
    const save = (patch) => tx(db, "readwrite", (s) => s.put({ ...d, ...patch, updatedAt: new Date().toISOString() }));
    try {
      const res = await fetch("/api/trips/" + d.tripId + "/pod", { method: "POST", body: formFor(d), credentials: "same-origin" });
      if (res.ok) await tx(db, "readwrite", (s) => s.delete(d.key));
      else {
        const body = await res.json().catch(() => ({}));
        const error = body.error || "Upload failed (" + res.status + ")";
        if (res.status === 404 || res.status === 409) await save({ state: "conflict", error, code: body.code || null });
        else if (res.status === 400 || res.status === 413 || res.status === 422) await save({ state: "failed", error });
        else {
          await save({ state: "queued", wasOffline: true, error });
          retry = true;
        }
      }
    } catch {
      await save({ state: "queued", wasOffline: true, error: "No connection. It will upload when you are back online." });
      retry = true;
    }
  }
  db.close();
  if (retry) throw new Error("retry later"); // makes the browser schedule another sync
}

// ---- Web Push: show the alert, and open the trip when it is tapped.
self.addEventListener("push", (e) => {
  let data = {};
  try {
    data = e.data ? e.data.json() : {};
  } catch {
    data = { title: "Truckwise", body: e.data ? e.data.text() : "" };
  }
  e.waitUntil(
    self.registration.showNotification(data.title || "Truckwise", {
      body: data.body || "",
      tag: data.tag, // the same alert never stacks twice
      icon: "/icons/icon-192.png",
      badge: "/icons/icon-192.png",
      data: { link: data.link || "/app/notifications" },
    }),
  );
});

self.addEventListener("notificationclick", (e) => {
  e.notification.close();
  const target = new URL((e.notification.data && e.notification.data.link) || "/app/notifications", self.location.origin).href;
  e.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((wins) => {
      for (const w of wins) {
        if ("focus" in w) {
          w.navigate(target);
          return w.focus();
        }
      }
      return self.clients.openWindow(target);
    }),
  );
});

self.addEventListener("sync", (e) => {
  if (e.tag === "lalolu-proof-sync") e.waitUntil(syncDrafts());
});
