"use client";

import Link from "next/link";
import { useEffect, useState } from "react";

export const NOTIFICATIONS_CHANGED = "lalolu-notifications-changed";

/** The "Alerts" link with an unread count. Re-checks every 30 seconds, when the tab regains focus, and after reading. */
export function NotificationLink({ initial }: { initial: number }) {
  const [n, setN] = useState(initial);

  useEffect(() => {
    let alive = true;
    const refresh = async () => {
      try {
        const res = await fetch("/api/notifications/unread-count", { cache: "no-store" });
        if (res.ok && alive) setN((await res.json()).unread);
      } catch {
        /* offline: keep the last number */
      }
    };
    const timer = window.setInterval(refresh, 30_000);
    const onVisible = () => document.visibilityState === "visible" && void refresh();
    window.addEventListener(NOTIFICATIONS_CHANGED, refresh);
    document.addEventListener("visibilitychange", onVisible);
    window.addEventListener("focus", refresh);
    return () => {
      alive = false;
      window.clearInterval(timer);
      window.removeEventListener(NOTIFICATIONS_CHANGED, refresh);
      document.removeEventListener("visibilitychange", onVisible);
      window.removeEventListener("focus", refresh);
    };
  }, []);

  return (
    <Link href="/app/notifications" aria-label={n > 0 ? `Alerts, ${n} unread` : "Alerts"} style={{ display: "inline-flex", gap: 6, alignItems: "center" }}>
      Alerts
      {n > 0 && (
        <span data-testid="unread-badge" className="chip chip-bad" style={{ padding: "1px 8px", fontSize: 12 }}>
          {n > 99 ? "99+" : n}
        </span>
      )}
    </Link>
  );
}
