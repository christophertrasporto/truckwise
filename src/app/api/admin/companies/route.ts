import { requireActor, route } from "@/server/http";
import { createCompany, listCompanies } from "@/server/services/admin";

export const GET = route(async (_req, ctx) => Response.json({ companies: await listCompanies(requireActor(ctx)) }));

export const POST = route(async (req, ctx) => Response.json(await createCompany(requireActor(ctx), await req.json(), { requestId: ctx.requestId }), { status: 201 }));
