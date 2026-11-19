"use client";

import { useRouter } from "next/navigation";
import { useCallback, useEffect, useState } from "react";
import { CHANGE_EVENT, deleteDraft, listDrafts, type Draft } from "@/lib/offline/db";
import { syncAll } from "@/lib/offline/queue";

/**
 * Registers the service worker (production only), keeps the proof upload queue moving, and shows the
 * driver what is waiting, failed or in conflict. Conflicts are never retried or overwritten: the person
 * reads the reason and decides to discard.
 */
export function OfflineSync() {
  const router = useRouter();
  const [drafts, setDrafts] = useState<Draft[]>([]);

  const refresh = useCallback(async () => {
    try {
      setDrafts((await listDrafts()).filter((d) => d.state !== "draft" && d.state !== "synced"));
    } catch {
      setDrafts([]); // IndexedDB unavailable (private mode): proofs just upload directly
    }
  }, []);

  useEffect(() => {
    if (process.env.NODE_ENV === "production" && "serviceWorker" in navigator) {
      navigator.serviceWorker.register("/sw.js").catch(() => undefined);
    }
    let alive = true;
    const run = async () => {
      await syncAll().catch(() => undefined);
      if (alive) {
        await refresh();
        router.refresh();
      }
    };
    void run();
    const onChange = () => void refresh();
    window.addEventListener(CHANGE_EVENT, onChange);
    window.addEventListener("online", run);
    const timer = window.setInterval(() => void syncAll().then(refresh).catch(() => undefined), 30_000);
    return () => {
      alive = false;
      window.removeEventListener(CHANGE_EVENT, onChange);
      window.removeEventListener("online", run);
      window.clearInterval(timer);
    };
  }, [refresh, router]);

  if (drafts.length === 0) return null;
  const waiting = drafts.filter((d) => d.state === "queued" || d.state === "uploading");
  const stuck = drafts.filter((d) => d.state === "failed" || d.state === "conflict");
  return (
    <div className="wrap" style={{ paddingTop: 12 }} role="status" aria-live="polite">
      {waiting.length > 0 && (
        <div className="notice" data-testid="offline-waiting">
          {waiting.length} proof{waiting.length > 1 ? "s are" : " is"} saved on this phone and will upload when you have a signal.{" "}
          <button className="btn btn-ghost btn-sm" onClick={() => void syncAll().then(refresh)}>Upload now</button>
        </div>
      )}
      {stuck.map((d) => (
        <div key={d.key} className="alert" style={{ marginTop: 8 }} data-testid={`offline-${d.state}`}>
          <b>{d.tripRef}, {d.stopLabel}:</b>{" "}
          {d.state === "conflict" ? "Could not be saved. " : "The server refused it. "}
          {d.error}{" "}
          <button className="btn btn-ghost btn-sm" onClick={() => void deleteDraft(d.key).then(refresh)}>Discard</button>
        </div>
      ))}
    </div>
  );
}
