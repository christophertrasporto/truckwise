import type { Metadata } from "next";
import Link from "next/link";
import { StatusChip } from "@/components/trip-ui";
import { requireTenant } from "@/server/auth/current";
import { can } from "@/server/policy";
import { calendarForStaff } from "@/server/services/calendar";

export const metadata: Metadata = { title: "Calendar" };

const MANILA_OFFSET_MS = 8 * 3600_000;
const dayOf = (d: Date | string) => new Date(new Date(d).getTime() + MANILA_OFFSET_MS).toISOString().slice(0, 10);
const addDays = (day: string, n: number) => dayOf(new Date(Date.parse(`${day}T00:00:00+08:00`) + n * 86_400_000));
const timeFmt = new Intl.DateTimeFormat("en-PH", { timeZone: "Asia/Manila", hour: "numeric", minute: "2-digit" });
const dayFmt = new Intl.DateTimeFormat("en-PH", { timeZone: "Asia/Manila", weekday: "short", month: "short", day: "numeric" });

export default async function CalendarPage({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }) {
  const actor = await requireTenant();
  if (!can(actor, "trip:read")) return <div className="empty">Your role does not include the calendar.</div>;
  const sp = await searchParams;
  const today = dayOf(new Date());
  const from = sp.from && /^\d{4}-\d{2}-\d{2}$/.test(sp.from) ? sp.from : today;
  const { scheduled, unscheduled } = await calendarForStaff(actor, from, 7);
  const days = Array.from({ length: 7 }, (_, i) => addDays(from, i));

  return (
    <div className="stack">
      <div className="page-head">
        <h1>Dispatch calendar</h1>
        <div className="actions">
          <Link className="btn btn-ghost btn-sm" href={`?from=${addDays(from, -7)}`}>Previous week</Link>
          <Link className="btn btn-ghost btn-sm" href="?">This week</Link>
          <Link className="btn btn-ghost btn-sm" href={`?from=${addDays(from, 7)}`}>Next week</Link>
        </div>
      </div>
      {days.map((day) => {
        const items = scheduled.filter((e) => dayOf(e.startsAt!) <= day && dayOf(e.endsAt!) >= day);
        return (
          <section key={day} className="panel stack" aria-label={dayFmt.format(new Date(`${day}T12:00:00+08:00`))}>
            <h2>{dayFmt.format(new Date(`${day}T12:00:00+08:00`))}{day === today ? " (today)" : ""}</h2>
            {items.length === 0 && <p className="muted">No trips.</p>}
            {items.map((e) => (
              <Link key={e.id} href={`/app/trips/${e.id}`} className="trip-card">
                <div className="row">
                  <b className="mono">{e.reference}</b>
                  <StatusChip status={e.status} />
                </div>
                <div>{e.origin ?? "-"} <span className="muted">to</span> {e.destination ?? "-"}</div>
                <div className="muted">
                  {timeFmt.format(new Date(e.startsAt!))} to {timeFmt.format(new Date(e.endsAt!))} · {e.customerName}
                  {" · "}
                  {e.driverName ? `${e.driverName}${e.company ? ` (${e.company})` : ""}${e.truckPlate ? ` · ${e.truckPlate}` : ""}` : "Unassigned"}
                </div>
              </Link>
            ))}
          </section>
        );
      })}
      <section className="panel stack">
        <h2>No schedule yet ({unscheduled.length})</h2>
        {unscheduled.length === 0 && <p className="muted">Every open trip has a pickup time.</p>}
        {unscheduled.map((e) => (
          <Link key={e.id} href={`/app/trips/${e.id}`} className="trip-card">
            <div className="row">
              <b className="mono">{e.reference}</b>
              <StatusChip status={e.status} />
            </div>
            <div className="muted">{e.customerName}</div>
          </Link>
        ))}
      </section>
    </div>
  );
}
