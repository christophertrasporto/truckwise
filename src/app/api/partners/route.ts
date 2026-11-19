import { requireTenantActor, route } from "@/server/http";
import { inviteSubcontractor, listPartners, subcontractorInput } from "@/server/services/partners";

export const GET = route(async (_req, ctx) => Response.json({ partners: await listPartners(requireTenantActor(ctx)) }));
export const POST = route(async (req, ctx) => {
  const res = await inviteSubcontractor(requireTenantActor(ctx), subcontractorInput.parse(await req.json()), { requestId: ctx.requestId });
  return Response.json(res, { status: 201 });
});
