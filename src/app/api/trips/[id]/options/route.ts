import { requireTenantActor, route } from "@/server/http";
import { truckOptionsForDriver } from "@/server/services/offers";

export const GET = route<{ id: string }>(async (_req, ctx, { id }) => Response.json(await truckOptionsForDriver(requireTenantActor(ctx), id)));
