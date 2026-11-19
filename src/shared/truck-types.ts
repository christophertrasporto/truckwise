/** Fixed list so a trip's truck requirement can be matched against a truck's type exactly. */
export const TRUCK_TYPES = [
  "4-wheeler",
  "6-wheeler",
  "10-wheeler",
  "12-wheeler",
  "Closed van",
  "Wing van",
  "Flatbed",
  "Refrigerated",
  "Boom truck",
  "Tractor head with trailer",
] as const;
export type TruckType = (typeof TRUCK_TYPES)[number];
