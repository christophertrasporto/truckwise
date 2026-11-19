import type { Db } from "./db";
import { auditLog } from "./db/schema";

export interface AuditEntry {
  tenantId: string | null;
  actorUserId: string | null;
  action: string;
  entityType: string;
  entityId?: string | null;
  oldValue?: unknown;
  newValue?: unknown;
  requestId?: string | null;
}

/** Call inside the same transaction as the change it records, so both commit or neither does. */
export async function writeAudit(db: Db, e: AuditEntry): Promise<void> {
  await db.insert(auditLog).values({
    tenantId: e.tenantId,
    actorUserId: e.actorUserId,
    action: e.action,
    entityType: e.entityType,
    entityId: e.entityId ?? null,
    oldValue: e.oldValue ?? null,
    newValue: e.newValue ?? null,
    requestId: e.requestId ?? null,
  });
}
