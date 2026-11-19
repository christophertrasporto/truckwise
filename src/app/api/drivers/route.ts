import { requireTenantActor, route } from "@/server/http";
import { listActiveDrivers } from "@/server/services/trips";

export const GET = route(async (_req, ctx) => Response.json({ drivers: await listActiveDrivers(requireTenantActor(ctx)) }));
