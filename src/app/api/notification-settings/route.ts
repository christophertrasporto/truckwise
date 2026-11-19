import { requireActor, route } from "@/server/http";
import { getNotificationSettings, saveNotificationSettings, settingsInput } from "@/server/notify/service";

export const GET = route(async (_req, ctx) => Response.json(await getNotificationSettings(requireActor(ctx))));
export const PUT = route(async (req, ctx) => Response.json(await saveNotificationSettings(requireActor(ctx), settingsInput.parse(await req.json()))));
