import { eq } from "drizzle-orm";
import { z } from "zod";
import { writeAudit } from "../audit";
import { withTenant } from "../db";
import { companySettings } from "../db/schema";
import { authorize } from "../policy";
import type { TenantActor } from "./trips";

export const settingsInput = z.object({
  claimMode: z.enum(["immediate", "approval_required"]),
  /** Approve clean, complete deliveries automatically (never exceptions). Off unless you turn it on. */
  podAutoApprove: z.boolean().optional(),
  allowPdfReceipts: z.boolean().optional(),
  /** VAT added to new invoices, in basis points (1200 = 12%). 0 if you do not charge VAT. */
  vatBps: z.number().int().min(0).max(2500).optional(),
});

export async function getSettings(actor: TenantActor) {
  authorize(actor, "settings:read");
  return withTenant(actor.tenantId, actor.userId, async (db) => {
    const [s] = await db.select().from(companySettings).where(eq(companySettings.tenantId, actor.tenantId));
    return {
      claimMode: s?.claimMode ?? "approval_required",
      podAutoApprove: s?.podAutoApprove ?? false,
      allowPdfReceipts: s?.allowPdfReceipts ?? false,
      vatBps: s?.vatBps ?? 0,
    };
  });
}

export async function updateSettings(actor: TenantActor, input: z.infer<typeof settingsInput>, ctx: { requestId?: string } = {}) {
  authorize(actor, "settings:write");
  return withTenant(actor.tenantId, actor.userId, async (db) => {
    const [before] = await db.select().from(companySettings).where(eq(companySettings.tenantId, actor.tenantId));
    const next = {
      claimMode: input.claimMode,
      podAutoApprove: input.podAutoApprove ?? before?.podAutoApprove ?? false,
      allowPdfReceipts: input.allowPdfReceipts ?? before?.allowPdfReceipts ?? false,
      vatBps: input.vatBps ?? before?.vatBps ?? 0,
    };
    if (before) await db.update(companySettings).set({ ...next, updatedAt: new Date() }).where(eq(companySettings.tenantId, actor.tenantId));
    else await db.insert(companySettings).values({ tenantId: actor.tenantId, ...next });
    await writeAudit(db, {
      tenantId: actor.tenantId,
      actorUserId: actor.userId,
      action: "settings.update",
      entityType: "company_settings",
      entityId: actor.tenantId,
      oldValue: before ? { claimMode: before.claimMode, podAutoApprove: before.podAutoApprove, allowPdfReceipts: before.allowPdfReceipts, vatBps: before.vatBps } : null,
      newValue: next,
      requestId: ctx.requestId,
    });
  });
}
