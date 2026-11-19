import { requireActor, route } from "@/server/http";
import { createPlan, listPlans } from "@/server/services/admin";

export const GET = route(async (_req, ctx) => Response.json({ plans: await listPlans(requireActor(ctx)) }));

export const POST = route(async (req, ctx) => Response.json(await createPlan(requireActor(ctx), await req.json(), { requestId: ctx.requestId }), { status: 201 }));
