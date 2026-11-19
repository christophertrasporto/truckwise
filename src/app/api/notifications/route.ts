import { requireTenantActor, route } from "@/server/http";
import { queryObject } from "@/server/query";
import { listNotifications, unreadCount } from "@/server/notify/service";

export const GET = route(async (req, ctx) => {
  const actor = requireTenantActor(ctx);
  const q = queryObject(req);
  const [notifications, unread] = await Promise.all([listNotifications(actor, { unreadOnly: q.unread === "1", limit: q.limit ? Number(q.limit) : undefined }), unreadCount(actor)]);
  return Response.json({ notifications, unread });
});
