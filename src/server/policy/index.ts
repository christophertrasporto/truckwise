export type Role =
  | "owner"
  | "ops_manager"
  | "dispatcher"
  | "accountant"
  | "driver"
  | "sub_owner"
  | "sub_manager"
  | "sub_driver"
  | "client";

export type TenantKind = "hauler" | "subcontractor";

export interface Actor {
  userId: string;
  tenantId: string | null;
  tenantKind: TenantKind | null;
  role: Role | null;
  isPlatformAdmin: boolean;
}

export type Action =
  | "tenant:create"
  | "tenant:suspend"
  | "tenant:read_all"
  | "member:read"
  | "member:manage"
  | "customer:read"
  | "customer:write"
  | "settings:read"
  | "settings:write"
  | "audit:read"
  | "partner:read"
  | "partner:manage"
  | "trip:create"
  | "trip:read"
  | "trip:view_rate"
  | "trip:offer"
  | "trip:cancel"
  | "trip:claim"
  | "trip:drive"
  | "pod:submit"
  | "pod:submit_proxy"
  | "pod:review"
  | "document:configure"
  | "pod:read"
  | "trip:reassign"
  | "fleet:read"
  | "fleet:manage"
  | "partner:accept"
  | "finance:read"
  | "invoice:manage"
  | "settlement:manage"
  | "settlement:read_own"
  | "expense:review"
  | "expense:add"
  | "expense:submit"
  | "money:edit"
  | "earnings:read"
  | "cost:read"
  | "cost:write"
  | "pnl:read";

const hauler = ["owner", "ops_manager", "dispatcher", "accountant"] as const;

/** Tenant-scoped permissions by role. Platform-only actions are handled separately below. */
const matrix: Record<Exclude<Action, "tenant:create" | "tenant:suspend" | "tenant:read_all">, readonly Role[]> = {
  "member:read": ["owner", "ops_manager", "sub_owner", "sub_manager"],
  "member:manage": ["owner", "sub_owner"],
  "customer:read": hauler,
  "customer:write": ["owner", "ops_manager", "dispatcher"],
  "settings:read": ["owner", "ops_manager"],
  "settings:write": ["owner"],
  "audit:read": ["owner", "ops_manager"],
  "partner:read": ["owner", "ops_manager", "dispatcher", "sub_owner", "sub_manager"],
  "partner:manage": ["owner", "ops_manager"],
  // Staff who see the whole trip, including the customer contract rate.
  "trip:create": ["owner", "ops_manager", "dispatcher"],
  "trip:read": hauler,
  "trip:view_rate": hauler,
  "trip:offer": ["owner", "ops_manager", "dispatcher"],
  "trip:cancel": ["owner", "ops_manager", "dispatcher"],
  // Drivers: claim offers, run their own trips, submit their own proof. "Own" is checked in the service.
  "trip:claim": ["driver"],
  "trip:drive": ["driver", "sub_driver"],
  "pod:submit": ["driver", "sub_driver"],
  "trip:reassign": ["owner", "ops_manager", "dispatcher"],
  "fleet:read": ["owner", "ops_manager", "dispatcher", "accountant", "sub_owner", "sub_manager"],
  "fleet:manage": ["owner", "ops_manager", "sub_owner", "sub_manager"],
  // A subcontractor company accepts offered trips with one of its trucks and drivers.
  "partner:accept": ["sub_owner", "sub_manager"],
  // Finance. Profit, invoices and settlements are for the people who run the money, not for dispatch or drivers.
  "finance:read": ["owner", "ops_manager", "accountant"],
  "invoice:manage": ["owner", "accountant"],
  "settlement:manage": ["owner", "accountant"],
  // A subcontractor company reads only the settlements addressed to it.
  "settlement:read_own": ["sub_owner", "sub_manager"],
  "expense:review": ["owner", "ops_manager", "accountant"],
  "expense:add": ["owner", "ops_manager", "dispatcher", "accountant"],
  "expense:submit": ["driver"],
  "money:edit": ["owner", "ops_manager", "accountant"],
  // A company driver sees their own payout and nothing about what the customer pays.
  "earnings:read": ["driver"],
  // The company cost ledger (diesel, RFID, maintenance...). Salaries inside it are further limited to owner and accountant.
  "cost:read": ["owner", "ops_manager", "accountant"],
  "cost:write": ["owner", "ops_manager", "accountant"],
  // Company-wide profit includes salaries.
  "pnl:read": ["owner", "accountant"],
  "pod:submit_proxy": ["owner", "ops_manager", "dispatcher"],
  "pod:review": ["owner", "ops_manager", "dispatcher"],
  // Which documents each client needs per trip, and waiving one for a trip.
  "document:configure": ["owner", "ops_manager"],
  "pod:read": hauler,
};

const platformOnly: ReadonlySet<Action> = new Set(["tenant:create", "tenant:suspend", "tenant:read_all"]);

export interface Resource {
  /** Tenant that owns the resource. If present it must match the actor's active tenant. */
  tenantId?: string | null;
}

/**
 * Central authorization decision. Every endpoint must call this (or `authorize`) server-side;
 * the UI hides controls but is never the enforcement point. Default is deny.
 */
export function can(actor: Actor, action: Action, resource: Resource = {}): boolean {
  if (platformOnly.has(action)) return actor.isPlatformAdmin;
  if (actor.isPlatformAdmin) return true;
  if (!actor.tenantId || !actor.role) return false;
  if (resource.tenantId && resource.tenantId !== actor.tenantId) return false;
  const allowed = matrix[action as keyof typeof matrix];
  return !!allowed && allowed.includes(actor.role);
}

export class ForbiddenError extends Error {
  readonly status = 403;
  constructor(action: Action) {
    super(`Forbidden: ${action}`);
  }
}

export function authorize(actor: Actor, action: Action, resource?: Resource): void {
  if (!can(actor, action, resource)) throw new ForbiddenError(action);
}
