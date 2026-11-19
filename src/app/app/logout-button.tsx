"use client";

import { useRouter } from "next/navigation";

export function LogoutButton() {
  const router = useRouter();
  return (
    <button
      className="btn btn-ghost"
      style={{ minHeight: 40, padding: "0 14px" }}
      onClick={async () => {
        await fetch("/api/auth/logout", { method: "POST" });
        // Forget any pages the service worker kept for offline use on this device.
        navigator.serviceWorker?.controller?.postMessage({ type: "clear-pages" });
        try {
          await caches?.delete("lalolu-pages-v1");
        } catch {
          /* no Cache Storage here */
        }
        router.replace("/login");
        router.refresh();
      }}
    >
      Sign out
    </button>
  );
}
