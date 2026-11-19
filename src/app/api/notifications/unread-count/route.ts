import { requireTenantActor, route } from "@/server/http";
import { unreadCount } from "@/server/notify/service";

export const GET = route(async (_req, ctx) => Response.json({ unread: await unreadCount(requireTenantActor(ctx)) }));
