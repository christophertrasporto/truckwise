import { requireTenantActor, route } from "@/server/http";
import { getSettings, settingsInput, updateSettings } from "@/server/services/settings";

export const GET = route(async (_req, ctx) => Response.json(await getSettings(requireTenantActor(ctx))));
export const PATCH = route(async (req, ctx) => {
  await updateSettings(requireTenantActor(ctx), settingsInput.parse(await req.json()), { requestId: ctx.requestId });
  return Response.json({ ok: true });
});
