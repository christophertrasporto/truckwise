import { desc } from "drizzle-orm";
import { z } from "zod";
import { writeAudit } from "@/server/audit";
import { withTenant } from "@/server/db";
import { customers } from "@/server/db/schema";
import { requireTenantActor, route } from "@/server/http";
import { authorize } from "@/server/policy";

const create = z.object({
  name: z.string().trim().min(1).max(200),
  contactName: z.string().trim().max(200).optional(),
  contactPhone: z.string().trim().max(50).optional(),
  address: z.string().trim().max(500).optional(),
});

export const GET = route(async (_req, ctx) => {
  const actor = requireTenantActor(ctx);
  authorize(actor, "customer:read");
  const rows = await withTenant(actor.tenantId, actor.userId, (db) =>
    db.select().from(customers).orderBy(desc(customers.createdAt)),
  );
  return Response.json({ customers: rows });
});

export const POST = route(async (req, ctx) => {
  const actor = requireTenantActor(ctx);
  authorize(actor, "customer:write");
  const input = create.parse(await req.json());
  const row = await withTenant(actor.tenantId, actor.userId, async (db) => {
    const [created] = await db.insert(customers).values({ ...input, tenantId: actor.tenantId }).returning();
    await writeAudit(db, {
      tenantId: actor.tenantId,
      actorUserId: actor.userId,
      action: "customer.create",
      entityType: "customer",
      entityId: created.id,
      newValue: input,
      requestId: ctx.requestId,
    });
    return created;
  });
  return Response.json({ customer: row }, { status: 201 });
});
