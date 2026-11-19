import { requireTenantActor, route } from "@/server/http";
import { queryObject } from "@/server/query";
import { getApplyToken, listApplications } from "@/server/services/applications";

export const GET = route(async (req, ctx) => {
  const actor = requireTenantActor(ctx);
  const s = queryObject(req).status;
  const status = s === "new" || s === "approved" || s === "rejected" ? s : undefined;
  return Response.json({ applications: await listApplications(actor, status), applyToken: await getApplyToken(actor) });
});
