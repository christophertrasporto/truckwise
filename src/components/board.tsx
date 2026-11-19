import Link from "next/link";
import { TRUCK_TYPES } from "@/shared/truck-types";
import { formatDateTime, formatPeso } from "@/shared/format";

export interface BoardItem {
  id: string;
  reference: string;
  customerName: string;
  cargoDescription: string;
  truckRequirement: string | null;
  weightKg: number | null;
  payoutCentavos: number;
  fuelIncluded?: boolean;
  tollIncluded?: boolean;
  offerMode: string;
  expiresAt: string | null;
  requested: boolean;
  route: { origin: string | null; destination: string | null; startsAt: string | null } | null;
  issues?: string[];
  haulerName?: string;
}

const modeLabel: Record<string, string> = {
  direct: "Offered to you",
  broadcast_internal: "Open to all drivers",
  broadcast_partners: "Open to subcontractors",
  broadcast_all: "Open to everyone",
  selected: "Offered to you and others",
  applicants: "Open call: apply",
};

export function BoardCard({ item, href }: { item: BoardItem; href: string }) {
  return (
    <Link href={href} className="trip-card">
      <div className="row">
        <b className="mono">{item.reference}</b>
        <span className={item.requested ? "chip chip-warn" : "chip chip-info"}>{item.requested ? "Requested" : modeLabel[item.offerMode] ?? item.offerMode}</span>
      </div>
      {item.haulerName && <div className="muted">From {item.haulerName}</div>}
      <div>
        {item.route?.origin ?? "-"} <span className="muted">to</span> {item.route?.destination ?? "-"}
      </div>
      <div className="muted">
        {item.route?.startsAt ? `Pickup ${formatDateTime(item.route.startsAt)}` : "Pickup time not set"} · {item.cargoDescription}
        {item.truckRequirement ? ` · ${item.truckRequirement}` : ""}
        {item.weightKg ? ` · ${item.weightKg} kg` : ""}
      </div>
      <div className="row">
        <b>{formatPeso(item.payoutCentavos)}</b>
        <span className="muted">
          {item.fuelIncluded != null && `${item.fuelIncluded ? "Fuel in" : "No fuel"} / ${item.tollIncluded ? "tolls in" : "no tolls"}`}
          {item.expiresAt && ` · answer by ${formatDateTime(item.expiresAt)}`}
        </span>
      </div>
      {item.issues && item.issues.length > 0 && <div className="alert" style={{ margin: 0 }}>{item.issues.join(" ")}</div>}
    </Link>
  );
}

/** Plain GET form: filters live in the URL, so the board works without client JavaScript. */
export function FilterForm({ values }: { values: { location?: string; from?: string; to?: string; truckType?: string; minPayoutCentavos?: number } }) {
  return (
    <details className="panel" open={Object.values(values).some((v) => v !== undefined)}>
      <summary style={{ cursor: "pointer", fontWeight: 600 }}>Filter trips</summary>
      <form method="get" className="stack" aria-label="Filter trips" style={{ marginTop: 14 }}>
      <div className="grid-form two">
        <div className="field" style={{ margin: 0 }}>
          <label htmlFor="f-loc">Place</label>
          <input id="f-loc" name="location" className="input" placeholder="City or address" defaultValue={values.location} />
        </div>
        <div className="field" style={{ margin: 0 }}>
          <label htmlFor="f-type">Truck type</label>
          <select id="f-type" name="truckType" className="input" defaultValue={values.truckType ?? ""}>
            <option value="">Any</option>
            {TRUCK_TYPES.map((t) => (
              <option key={t}>{t}</option>
            ))}
          </select>
        </div>
        <div className="field" style={{ margin: 0 }}>
          <label htmlFor="f-from">From date</label>
          <input id="f-from" name="from" type="date" className="input" defaultValue={values.from} />
        </div>
        <div className="field" style={{ margin: 0 }}>
          <label htmlFor="f-to">To date</label>
          <input id="f-to" name="to" type="date" className="input" defaultValue={values.to} />
        </div>
        <div className="field" style={{ margin: 0 }}>
          <label htmlFor="f-min">Minimum payout (PHP)</label>
          <input id="f-min" name="minPayout" inputMode="decimal" className="input" placeholder="e.g. 10000" defaultValue={values.minPayoutCentavos != null ? values.minPayoutCentavos / 100 : undefined} />
        </div>
      </div>
      <div className="actions">
        <button className="btn btn-primary btn-sm">Apply filters</button>
        <Link href="?" className="btn btn-ghost btn-sm">
          Clear
        </Link>
      </div>
      </form>
    </details>
  );
}
