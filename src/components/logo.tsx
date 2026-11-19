import Link from "next/link";
import { TruckIcon } from "./icons";

export function Logo({ href = "/" }: { href?: string }) {
  return (
    <Link href={href} className="logo" aria-label="Truckwise home">
      <span className="logo-mark">
        <TruckIcon size={20} />
      </span>
      <span>Truckwise</span>
    </Link>
  );
}
