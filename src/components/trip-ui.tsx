import Link from "next/link";
import { tripStatusLabel, type TripStatus } from "@/shared/state-machines/trip";

const tone: Partial<Record<TripStatus, string>> = {
  created: "chip",
  offered: "chip chip-info",
  assigned: "chip chip-info",
  started: "chip chip-info",
  arrived_pickup: "chip chip-info",
  loaded: "chip chip-info",
  in_transit: "chip chip-info",
  arrived_destination: "chip chip-warn",
  pod_submitted: "chip chip-warn",
  delivery_exception: "chip chip-bad",
  ready_for_invoice: "chip chip-ok",
  cancelled: "chip",
};

export function StatusChip({ status }: { status: TripStatus }) {
  return <span className={tone[status] ?? "chip"}>{tripStatusLabel[status]}</span>;
}

export function TripCard({
  id,
  reference,
  status,
  customerName,
  cargo,
  right,
}: {
  id: string;
  reference: string;
  status: TripStatus;
  customerName: string;
  cargo: string;
  right?: React.ReactNode;
}) {
  return (
    <Link href={`/app/trips/${id}`} className="trip-card">
      <div className="row">
        <b className="mono">{reference}</b>
        <StatusChip status={status} />
      </div>
      <div>{customerName}</div>
      <div className="row">
        <span className="muted">{cargo}</span>
        {right}
      </div>
    </Link>
  );
}
