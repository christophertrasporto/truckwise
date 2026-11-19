import type { Metadata } from "next";
import { requireTenant } from "@/server/auth/current";
import { listNotifications } from "@/server/notify/service";
import { NotificationList } from "./notification-list";

export const metadata: Metadata = { title: "Alerts" };

export default async function NotificationsPage() {
  const actor = await requireTenant();
  const items = await listNotifications(actor, { limit: 100 });
  return (
    <div className="stack">
      <div className="page-head">
        <h1>Alerts</h1>
      </div>
      <NotificationList items={items} />
    </div>
  );
}
