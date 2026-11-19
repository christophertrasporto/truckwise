import { requireActor, route } from "@/server/http";
import { setCompanyStatus } from "@/server/services/admin";

export const POST = route<{ id: string }>(async (req, ctx, { id }) => Response.json(await setCompanyStatus(requireActor(ctx), id, await req.json(), { requestId: ctx.requestId })));
