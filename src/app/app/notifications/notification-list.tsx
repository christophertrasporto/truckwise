"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { post } from "@/components/api";
import { NOTIFICATIONS_CHANGED } from "@/components/notification-link";

interface Item {
  id: string;
  kind: string;
  title: string;
  body: string;
  link: string | null;
  createdAt: string | null;
  read: boolean;
}

const when = (iso: string | null) =>
  iso ? new Intl.DateTimeFormat("en-PH", { timeZone: "Asia/Manila", dateStyle: "medium", timeStyle: "short" }).format(new Date(iso)) : "";

export function NotificationList({ items: initial }: { items: Item[] }) {
  const router = useRouter();
  const [items, setItems] = useState(initial);
  const unread = items.filter((i) => !i.read).length;

  async function open(i: Item) {
    if (!i.read) {
      setItems((all) => all.map((x) => (x.id === i.id ? { ...x, read: true } : x)));
      await post("/api/notifications/read", { ids: [i.id] });
      window.dispatchEvent(new CustomEvent(NOTIFICATIONS_CHANGED));
    }
    if (i.link) router.push(i.link);
  }
  async function readAll() {
    setItems((all) => all.map((x) => ({ ...x, read: true })));
    await post("/api/notifications/read", { all: true });
    window.dispatchEvent(new CustomEvent(NOTIFICATIONS_CHANGED));
  }

  if (items.length === 0) return <div className="empty">Nothing yet. You will see new trips, requests and decisions here.</div>;
  return (
    <div className="stack">
      <div className="actions">
        <button className="btn btn-ghost btn-sm" onClick={readAll} disabled={unread === 0}>
          Mark all as read{unread > 0 ? ` (${unread})` : ""}
        </button>
      </div>
      {items.map((i) => (
        <button
          key={i.id}
          onClick={() => open(i)}
          className="trip-card"
          style={{ textAlign: "left", font: "inherit", color: "inherit", cursor: "pointer", borderLeft: i.read ? undefined : "4px solid var(--brand-2)" }}
          aria-label={`${i.read ? "" : "Unread: "}${i.title}. ${i.body}`}
        >
          <div className="row">
            <b>{i.title}</b>
            {!i.read && <span className="chip chip-info">New</span>}
          </div>
          <div>{i.body}</div>
          <div className="muted">{when(i.createdAt)}</div>
        </button>
      ))}
    </div>
  );
}
