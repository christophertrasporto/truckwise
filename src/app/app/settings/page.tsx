import type { Metadata } from "next";
import { requireTenant } from "@/server/auth/current";
import { can } from "@/server/policy";
import { mySubscription } from "@/server/services/entitlements";
import { getSettings } from "@/server/services/settings";
import { formatDateTime, formatPeso } from "@/shared/format";
import { SettingsForm } from "./settings-form";

export const metadata: Metadata = { title: "Dispatch settings" };

export default async function SettingsPage() {
  const actor = await requireTenant();
  if (!can(actor, "settings:read")) return <div className="empty">Your role does not include settings.</div>;
  const settings = await getSettings(actor);
  const plan = await mySubscription(actor.tenantId, actor.userId);
  return (
    <div className="stack" style={{ maxWidth: 640 }}>
      <div className="page-head">
        <h1>Dispatch settings</h1>
      </div>
      {plan && (
        <section className="panel" aria-label="Your plan">
          <dl className="kv">
            <div><dt>Plan</dt><dd>{plan.plan}</dd></div>
            <div><dt>Status</dt><dd>{plan.status}</dd></div>
            <div><dt>{plan.status === "trialing" ? "Trial ends" : "Paid until"}</dt><dd>{formatDateTime(plan.periodEnd)}</dd></div>
            <div><dt>Price</dt><dd>{formatPeso(plan.priceCentavos)} every {plan.periodMonths} month{plan.periodMonths > 1 ? "s" : ""}</dd></div>
          </dl>
        </section>
      )}
      <SettingsForm initial={settings} canEdit={can(actor, "settings:write")} />
    </div>
  );
}
