import type { ReactNode } from "react";

const base = {
  width: 22,
  height: 22,
  viewBox: "0 0 24 24",
  fill: "none",
  stroke: "currentColor",
  strokeWidth: 1.8,
  strokeLinecap: "round",
  strokeLinejoin: "round",
  "aria-hidden": true,
} as const;

const mk = (d: ReactNode) =>
  function Icon(props: { size?: number }) {
    return (
      <svg {...base} width={props.size ?? 22} height={props.size ?? 22}>
        {d}
      </svg>
    );
  };

export const TruckIcon = mk(
  <>
    <path d="M3 6h11v10H3zM14 9h4l3 3v4h-7" />
    <circle cx="7" cy="17.5" r="1.8" />
    <circle cx="17" cy="17.5" r="1.8" />
  </>,
);
export const RouteIcon = mk(
  <>
    <circle cx="6" cy="19" r="2" />
    <circle cx="18" cy="5" r="2" />
    <path d="M8 19h6a4 4 0 0 0 0-8h-4a4 4 0 0 1 0-8h6" />
  </>,
);
export const CameraIcon = mk(
  <>
    <path d="M4 8h3l2-3h6l2 3h3v11H4z" />
    <circle cx="12" cy="13" r="3.5" />
  </>,
);
export const PesoIcon = mk(
  <>
    <path d="M7 20V4h6a4 4 0 0 1 0 8H7M4 9h12M4 13h12" />
  </>,
);
export const ShieldIcon = mk(
  <>
    <path d="M12 3l8 3v6c0 5-3.5 8-8 9-4.5-1-8-4-8-9V6z" />
    <path d="M9 12l2 2 4-4" />
  </>,
);
export const UsersIcon = mk(
  <>
    <circle cx="9" cy="8" r="3.2" />
    <path d="M3 20c0-3.3 2.7-6 6-6s6 2.7 6 6M16 5.2a3.2 3.2 0 0 1 0 5.6M18 14.4c1.8.8 3 2.6 3 5.6" />
  </>,
);
export const PhoneIcon = mk(
  <>
    <rect x="7" y="2.5" width="10" height="19" rx="2.5" />
    <path d="M11 18.5h2" />
  </>,
);
export const WifiOffIcon = mk(
  <>
    <path d="M3 3l18 18M8.5 16.4a5 5 0 0 1 7 0M5 12.9a10 10 0 0 1 3.2-2M10.7 6.1A15 15 0 0 1 22 9.5M2 9.5a15 15 0 0 1 3-2" />
    <circle cx="12" cy="19.5" r=".6" />
  </>,
);
export const CheckIcon = mk(<path d="M5 12.5l4.5 4.5L19 7.5" />);
export const ArrowIcon = mk(<path d="M5 12h14M13 6l6 6-6 6" />);
