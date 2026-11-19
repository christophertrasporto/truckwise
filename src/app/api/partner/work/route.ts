import { requireTenantActor, route } from "@/server/http";
import { listPartnerWork } from "@/server/services/partner";

export const GET = route(async (_req, ctx) => Response.json(await listPartnerWork(requireTenantActor(ctx))));
