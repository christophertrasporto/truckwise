import { requireTenantActor, route } from "@/server/http";
import { listExpensesToReview } from "@/server/services/finance/expenses";

export const GET = route(async (_req, ctx) => Response.json({ expenses: await listExpensesToReview(requireTenantActor(ctx)) }));
