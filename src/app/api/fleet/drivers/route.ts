import { requireTenantActor, route } from "@/server/http";
import { listDrivers } from "@/server/services/fleet";

export const GET = route(async (_req, ctx) => Response.json({ drivers: await listDrivers(requireTenantActor(ctx)) }));
