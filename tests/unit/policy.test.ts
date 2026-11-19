import { describe, expect, it } from "vitest";
import { can, type Actor, type Role } from "@/server/policy";

const actor = (role: Role | null, tenantId: string | null = "t1", extra: Partial<Actor> = {}): Actor => ({
  userId: "u1",
  tenantId,
  tenantKind: "hauler",
  role,
  isPlatformAdmin: false,
  ...extra,
});

describe("policy.can", () => {
  it("denies everything without an active tenant or role", () => {
    expect(can(actor(null, null), "customer:read")).toBe(false);
    expect(can(actor("owner", null), "customer:read")).toBe(false);
  });

  it("lets haulers staff read customers but not drivers, subcontractors or clients", () => {
    for (const r of ["owner", "ops_manager", "dispatcher", "accountant"] as Role[]) {
      expect(can(actor(r), "customer:read")).toBe(true);
    }
    for (const r of ["driver", "sub_owner", "sub_manager", "sub_driver", "client"] as Role[]) {
      expect(can(actor(r), "customer:read")).toBe(false);
    }
  });

  it("limits writes: dispatcher writes customers but not settings; accountant writes neither", () => {
    expect(can(actor("dispatcher"), "customer:write")).toBe(true);
    expect(can(actor("dispatcher"), "settings:write")).toBe(false);
    expect(can(actor("accountant"), "customer:write")).toBe(false);
    expect(can(actor("owner"), "settings:write")).toBe(true);
  });

  it("denies resources owned by another tenant", () => {
    expect(can(actor("owner"), "customer:read", { tenantId: "t1" })).toBe(true);
    expect(can(actor("owner"), "customer:read", { tenantId: "t2" })).toBe(false);
  });

  it("keeps platform actions to platform admins only", () => {
    expect(can(actor("owner"), "tenant:create")).toBe(false);
    expect(can(actor(null, null, { isPlatformAdmin: true }), "tenant:create")).toBe(true);
    expect(can(actor("owner"), "tenant:suspend")).toBe(false);
  });

  it("only owners manage members and partner approvals are not open to drivers", () => {
    expect(can(actor("dispatcher"), "member:manage")).toBe(false);
    expect(can(actor("owner"), "member:manage")).toBe(true);
    expect(can(actor("driver"), "partner:manage")).toBe(false);
    expect(can(actor("sub_driver"), "audit:read")).toBe(false);
  });
});
